import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

/**
 * The statement of account, produced by a scheduled statement run.
 *
 * Section 4 of the invoice selection spec was built as modules
 * (statementLedger, statementAgeing, statementOfAccountPdf) and unit tested,
 * but nothing called any of it — so a client on a live workspace still
 * received only the NDIS budget statement, which reports plan budget against
 * services delivered and contains no invoice or payment at all. This is the
 * test for the wiring.
 *
 * The two documents run alongside each other: the budget statement answers
 * "what was delivered", the statement of account answers "what is owed". A run
 * produces both, each with its own PDFLink row.
 */

const uploadedKeys = [];
const renderedInputs = [];

vi.mock('@pdfme/generator', () => ({
  generate: vi.fn(async ({ inputs }) => {
    renderedInputs.push(inputs[0]);
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  }),
}));

vi.mock('../../src/utils/uploadS3.js', () => ({
  uploadFileToS3: vi.fn(async (_buf, key) => {
    uploadedKeys.push(key);
    return { $metadata: { httpStatusCode: 200 } };
  }),
  getS3FileUrl: vi.fn(async (key) => `https://s3.example/${key}`),
  getS3File: vi.fn(async () => Buffer.from('logo')),
}));

const { default: Board } = await import('../../src/models/Board.js');
const { default: Business } = await import('../../src/models/Business.js');
const { default: Item } = await import('../../src/models/Item.js');
const { default: PDFLink } = await import('../../src/models/PDFLink.js');
const {
  PDFLINK_TYPE_NDIS_INVOICE,
  PDFLINK_TYPE_MONTHLY_STATEMENT,
  PDFLINK_TYPE_STATEMENT_OF_ACCOUNT,
} = await import('../../src/constants/automation.js');
const { generateStatementsForBoard } = await import('../../src/services/automation/generateStatements.js');

const WORKSPACE = '55369';
const BOARD = 'eNiJpH14PN3';
const PARTICIPANT = 'Masoud Test';
const TZ = 'Australia/Sydney';
// A slot in September makes previousCalendarMonth resolve to August 2026.
const SLOT = '2026-09-01T13:00:00.000Z';
const PERIOD_KEY = '20260901-2300';

/** The statement-of-account render, identified by the block only it produces. */
const statementRender = () => renderedInputs.find((input) => input?.transactions !== undefined);

async function seed() {
  await Promise.all([Board, Business, Item, PDFLink].map((m) => m.deleteMany({})));

  await Board.create({
    boardId: BOARD,
    workspaceId: WORKSPACE,
    name: 'Care Management NDIS 2026 Pricing',
    label: 'Care Management NDIS 2026 Pricing',
  });
  await Business.create({
    workspaceId: WORKSPACE,
    name: 'Dev-Test11',
    abn: '12 345 678 901',
    bankDetails: {
      accountName: 'Dev-Test11 Pty Ltd', bankName: 'CBA', bsb: '062-000', accountNumber: '12345678',
    },
  });

  // The participant, and one service record carrying a payment against INV-1205.
  await Item.create({
    itemId: 'item-1',
    workspaceId: WORKSPACE,
    boardId: BOARD,
    folderId: 'folder-1',
    invoicedBy: 'INV-1205',
    data: {
      'Full Name/Preferred Name': PARTICIPANT,
      'Amount Received($)': '100',
      'Invoice Received Date': '2026-08-20T00:00:00.000Z',
    },
  });

  // The invoice the statement must account for.
  await PDFLink.create({
    workspaceId: WORKSPACE,
    boardId: BOARD,
    itemId: 'item-1',
    participant: PARTICIPANT,
    type: PDFLINK_TYPE_NDIS_INVOICE,
    invoiceNumber: 'INV-1205',
    invoiceTotal: 250,
    periodKey: '20260801-2300',
    pdfLink: 'https://s3.example/inv-1205.pdf',
    createdAt: new Date('2026-08-05T00:00:00.000Z'),
  });
}

beforeEach(async () => {
  uploadedKeys.length = 0;
  renderedInputs.length = 0;
  await seed();
});

describe('a scheduled statement run', () => {
  it('writes a statement of account alongside the monthly statement', async () => {
    await generateStatementsForBoard({
      workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
    });

    const types = (await PDFLink.find({ periodKey: PERIOD_KEY }).lean()).map((r) => r.type);
    expect(types).toContain(PDFLINK_TYPE_MONTHLY_STATEMENT);
    expect(types).toContain(PDFLINK_TYPE_STATEMENT_OF_ACCOUNT);
  });

  it('accounts for the invoice and the payment recorded against it', async () => {
    await generateStatementsForBoard({
      workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
    });

    const rendered = statementRender();
    expect(rendered).toBeDefined();
    const rows = JSON.parse(rendered.transactions);
    // A charge row for the invoice and a payment row against it.
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.includes('INV-1205'))).toBe(true);
    // $250 charged, $100 received, so $150 closes the period.
    expect(JSON.parse(rendered.summary)[0]).toEqual(['$0.00', '$250.00', '$100.00', '$150.00']);
  });

  it('replays without producing a second statement of account', async () => {
    const run = () => generateStatementsForBoard({
      workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
    });
    await run();
    await run();

    const written = await PDFLink.countDocuments({
      periodKey: PERIOD_KEY, type: PDFLINK_TYPE_STATEMENT_OF_ACCOUNT,
    });
    expect(written).toBe(1);
  });

  // Section 4.5. Nothing invoiced, nothing owing, nothing to say.
  it('sends no statement of account for an account with no activity', async () => {
    await PDFLink.deleteMany({ type: PDFLINK_TYPE_NDIS_INVOICE });
    await Item.updateOne({ itemId: 'item-1' }, { $unset: { invoicedBy: '' } });

    await generateStatementsForBoard({
      workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
    });

    const written = await PDFLink.countDocuments({ type: PDFLINK_TYPE_STATEMENT_OF_ACCOUNT });
    expect(written).toBe(0);
  });
});
