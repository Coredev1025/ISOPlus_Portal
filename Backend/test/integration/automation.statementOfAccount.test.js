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
      'Participant Full Name': PARTICIPANT,
      'Amount Received($)': '100',
      'Invoice Received Date': '2026-08-20T00:00:00.000Z',
      // Shift dates inside the August period, so the participant has services
      // to report and the budget statement is issued. Without them the run
      // now correctly issues no budget statement at all — an all-zero document
      // is not sent — and these cases assert that both documents appear.
      'Scheduled Shift Start Date & Time': '2026-08-15T09:00:00.000Z',
      'Actual Shift End Date & Time': '2026-08-15T11:00:00.000Z',
      'Total Amount ($)': '250.00',
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

/**
 * The summary strip, as the four separate `text` fields the template now
 * carries. It was a one-row table until the statement adopted the supplied
 * design; the values and their order are unchanged.
 */
const summaryStrip = (inputs) => [
  inputs.openingBalance,
  inputs.totalCharges,
  inputs.totalPayments,
  inputs.closingBalance,
];

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
    expect(summaryStrip(rendered)).toEqual(['$0.00', '$250.00', '$100.00', '$150.00']);
  });

  /**
   * The case the whole invoice-date field exists for.
   *
   * An operator raises an invoice by hand and sets `Invoice Date` to a day
   * inside the period. The row is written today, after the period closed. Dated
   * by its write time the invoice falls outside the window and the statement
   * omits it entirely — which is what a client sees as a statement that
   * understates what they owe. Dated by the invoice's own date it appears where
   * it belongs.
   */
  it('accounts for a backdated invoice on the date the invoice claims', async () => {
    await PDFLink.create({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      itemId: 'item-backdated',
      participant: PARTICIPANT,
      type: PDFLINK_TYPE_NDIS_INVOICE,
      invoiceNumber: 'INV-1301',
      invoiceTotal: 400,
      pdfLink: 'https://s3.example/inv-1301.pdf',
      // Raised after the period closed, for work delivered inside it.
      invoiceDate: new Date('2026-08-20T00:00:00.000Z'),
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
    });

    await generateStatementsForBoard({
      workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
    });

    const rendered = statementRender();
    const rows = JSON.parse(rendered.transactions);
    const backdated = rows.find((row) => row.includes('INV-1301'));
    expect(backdated).toBeDefined();
    expect(backdated[0]).toBe('20/08/2026');
    // $250 + $400 charged against the $100 received.
    expect(summaryStrip(rendered)).toEqual(['$0.00', '$650.00', '$100.00', '$550.00']);
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

  /**
   * Section 4.1: the period is configured separately from invoicing and can be
   * weekly. The cadence already decides when the job fires; it must also
   * decide what the statement covers, or a weekly workspace receives the whole
   * of last month again every week.
   *
   * The slot is 1 September in Sydney, so a weekly period is 25–31 August. The
   * seeded invoice (5 August) and its payment (20 August) both fall before it:
   * they belong to the opening balance, not to this period's charges and
   * payments, and the account still closes at the $150 owing.
   */
  it('covers the week, not the month, on a weekly cadence', async () => {
    await generateStatementsForBoard({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      slot: SLOT,
      timezone: TZ,
      periodKey: PERIOD_KEY,
      schedule: { every: { n: 1, unit: 'week' } },
    });

    const rendered = statementRender();
    expect(rendered).toBeDefined();
    expect(summaryStrip(rendered)).toEqual(['$150.00', '$0.00', '$0.00', '$150.00']);
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

/**
 * Ways a real board's data can differ from the tidy seed above.
 * Each of these took the whole board's run down, not one participant's —
 * except the name-field split, which silently printed Payments $0.00.
 */
describe('a scheduled statement run, on untidy data', () => {
  const run = () => generateStatementsForBoard({
    workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
  });

  // ISO+ keeps the participant's name on the profile as Full Name/Preferred
  // Name, and the payment on the shift as Participant Full Name. The tidy seed
  // puts both on one item, which is how a $100 payment can look collected
  // while portal-dev still prints Payments $0.00 — the lookup reads the
  // profile field, so it never sees the shift.
  it('reads a payment off the shift, not the participant profile', async () => {
    await Item.updateOne({ itemId: 'item-1' }, { $unset: { 'data.Full Name/Preferred Name': '' } });
    await Item.create({
      itemId: 'profile-1',
      workspaceId: WORKSPACE,
      boardId: BOARD,
      folderId: 'folder-profile',
      data: { 'Full Name/Preferred Name': PARTICIPANT },
    });

    await run();

    const rendered = statementRender();
    expect(rendered).toBeDefined();
    const rows = JSON.parse(rendered.transactions);
    expect(rows.some((row) => row.includes('Payment received'))).toBe(true);
    expect(summaryStrip(rendered)).toEqual(['$0.00', '$250.00', '$100.00', '$150.00']);
  });

  // ISO+ lets the amount and the received date be entered separately.
  it('still states the account when a payment has no received date', async () => {
    await Item.updateOne({ itemId: 'item-1' }, { $unset: { 'data.Invoice Received Date': '' } });

    await run();

    const rendered = statementRender();
    expect(rendered).toBeDefined();
    // Netted onto the invoice's row rather than given a dated one.
    expect(JSON.parse(rendered.transactions)).toHaveLength(1);
    expect(summaryStrip(rendered)).toEqual(['$0.00', '$250.00', '$100.00', '$150.00']);
  });

  // Payments are read per board; the invoices must be too, or an invoice
  // raised on board B shows as owing on board A's statement as well.
  it('leaves an invoice raised on another board to that board\'s statement', async () => {
    await PDFLink.create({
      workspaceId: WORKSPACE,
      boardId: 'otherBoard01',
      itemId: 'item-9',
      participant: PARTICIPANT,
      type: PDFLINK_TYPE_NDIS_INVOICE,
      invoiceNumber: 'INV-9999',
      invoiceTotal: 999,
      periodKey: '20260801-2300',
      pdfLink: 'https://s3.example/inv-9999.pdf',
      createdAt: new Date('2026-08-06T00:00:00.000Z'),
    });

    await run();

    const rendered = statementRender();
    expect(summaryStrip(rendered)).toEqual(['$0.00', '$250.00', '$100.00', '$150.00']);
  });

  // A payment recorded against an invoice the ledger has no row for — one
  // raised by hand, before the generators recorded a total — puts a payment on
  // the ledger and nothing in the ageing, so the two cannot agree and section
  // 4.3's check refuses the document. That is one participant's problem to fix
  // on ISO+, and the rest of the board must not wait on it.
  it('finishes the board when one participant\'s account cannot be stated', async () => {
    await Item.create({
      itemId: 'item-2',
      workspaceId: WORKSPACE,
      boardId: BOARD,
      folderId: 'folder-1',
      invoicedBy: 'INV-GHOST',
      data: {
        'Full Name/Preferred Name': 'Aaron Test',
        'Participant Full Name': 'Aaron Test',
        'Amount Received($)': '50',
        'Invoice Received Date': '2026-08-20T00:00:00.000Z',
        'Scheduled Shift Start Date & Time': '2026-08-16T09:00:00.000Z',
        'Actual Shift End Date & Time': '2026-08-16T11:00:00.000Z',
        'Total Amount ($)': '250.00',
      },
    });

    const results = await run();

    const accounts = await PDFLink.find({ type: PDFLINK_TYPE_STATEMENT_OF_ACCOUNT }).lean();
    expect(accounts.map((row) => row.participant)).toEqual([PARTICIPANT]);
    // Both budget statements were still written, and both are handed back.
    const budget = results.filter((row) => row.itemId.startsWith('statement:'));
    expect(budget.map((row) => row.participant)).toEqual(['Aaron Test', PARTICIPANT]);
  });
});

/**
 * The shape a real automation run actually writes.
 *
 * `recordPdfLinks` files one PDFLink row per itemId and stamps the whole
 * invoice's `invoiceTotal` on every one of them, so an invoice covering N
 * shifts leaves N rows carrying the full amount and one shared `pdfLink`. The
 * statement must read them as one document. It cannot key on `invoiceNumber` —
 * a hand-raised row may carry none — so `pdfLink` is the identity, which is
 * what `uniquePdfResults` and the recent-documents aggregation already use.
 *
 * The reason this is worth an integration test rather than a unit one: with no
 * payment recorded, the charges and the ageing buckets scale by the same N, so
 * section 4.3's and 4.4's reconciliation checks both pass and the overstated
 * statement is rendered, filed and emailed.
 */
describe('a scheduled statement run, on a multi-item invoice', () => {
  const run = () => generateStatementsForBoard({
    workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
  });

  /** The second shift on INV-1205: same document, same total, its own row. */
  const secondRowOf = (overrides) => PDFLink.create({
    workspaceId: WORKSPACE,
    boardId: BOARD,
    itemId: 'item-1b',
    participant: PARTICIPANT,
    type: PDFLINK_TYPE_NDIS_INVOICE,
    invoiceNumber: 'INV-1205',
    invoiceTotal: 250,
    periodKey: '20260801-2300',
    pdfLink: 'https://s3.example/inv-1205.pdf',
    createdAt: new Date('2026-08-05T00:00:00.000Z'),
    ...overrides,
  });

  it('charges a two-item invoice once, not once per item', async () => {
    // No payment: this is the case where both reconciliation checks still pass.
    await Item.updateOne({ itemId: 'item-1' }, { $unset: { 'data.Amount Received($)': '' } });
    await secondRowOf({});

    await run();

    const rendered = statementRender();
    expect(rendered).toBeDefined();
    expect(JSON.parse(rendered.transactions)).toHaveLength(1);
    expect(summaryStrip(rendered)).toEqual(['$0.00', '$250.00', '$0.00', '$250.00']);
  });

  it('carries a prior-period multi-item invoice into the opening balance once', async () => {
    await Item.updateOne({ itemId: 'item-1' }, { $unset: { 'data.Amount Received($)': '' } });
    // Both rows moved to July, before the August period opens.
    const july = new Date('2026-07-05T00:00:00.000Z');
    await PDFLink.updateOne({ itemId: 'item-1' }, { $set: { createdAt: july } });
    await secondRowOf({ createdAt: july });

    await run();

    const rendered = statementRender();
    expect(rendered).toBeDefined();
    expect(summaryStrip(rendered)).toEqual(['$250.00', '$0.00', '$0.00', '$250.00']);
  });
});
