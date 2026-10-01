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

const { getS3File } = await import('../../src/utils/uploadS3.js');
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
const { generateStatementOfAccount } = await import('../../src/services/automation/generateStatementOfAccount.js');

const WORKSPACE = '55369';
const BOARD = 'eNiJpH14PN3';
const PARTICIPANT = 'Masoud Test';
const TZ = 'Australia/Sydney';
// A slot in September makes previousCalendarMonth resolve to August 2026.
const SLOT = '2026-09-01T13:00:00.000Z';
const PERIOD_KEY = '20260901-2300';
const LOGO_KEY = 'logos/55369/logo.png';
// What the mocked store returns for that key, as getLogoData renders it.
const LOGO_DATA_URI = `data:image/png;base64,${Buffer.from('logo').toString('base64')}`;

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
    defaultLogo: LOGO_KEY,
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
      'Payment Received Date': '2026-08-20T00:00:00.000Z',
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
  // The store is read for the letterhead on both documents, so the call log
  // and any one-shot override have to start clean for each case.
  getS3File.mockReset();
  getS3File.mockResolvedValue(Buffer.from('logo'));
  await seed();
});

/**
 * The closing balance, as the template still renders it.
 *
 * KAN-276 removed the Opening Balance / Charges / Payments / Closing Balance
 * summary strip these tests used to read via a `summaryStrip` helper — the
 * reference statements (Purple Lotus, Westpoint Group) never carried it — so
 * `openingBalance`/`totalCharges`/`totalPayments`/`closingBalance` are no
 * longer among the inputs handed to the template at all. `amountDue` is the
 * one figure of that group still rendered ("BALANCE DUE AUD"), and every case
 * below was really asserting on the closing balance regardless of cadence,
 * board isolation or invoice dedup — so it remains the discriminating check.
 */
const closingBalanceOf = (inputs) => inputs.amountDue;

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
    expect(closingBalanceOf(rendered)).toBe('$150.00');
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
    expect(closingBalanceOf(rendered)).toBe('$550.00');
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
   * weekly. The cadence still decides when the job fires and what the
   * statement's own period covers (its header, `periodKey`, and de-duplication
   * against re-running the same slot) — but KAN-274 means that no longer
   * changes which invoices and payments appear as line items: every one of
   * them shows regardless of cadence, so a weekly workspace closes at the same
   * $150 a monthly one would.
   *
   * The slot is 1 September in Sydney, so a weekly period is 25–31 August. The
   * seeded invoice (5 August) and its payment (20 August) both fall before
   * that window, and still show as their own charge and payment rows rather
   * than being folded into an opening balance.
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
    expect(closingBalanceOf(rendered)).toBe('$150.00');
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
    expect(closingBalanceOf(rendered)).toBe('$150.00');
  });

  // ISO+ lets the amount and the received date be entered separately. An
  // amount with no Payment Received Date is bad data and is left off (KAN-285).
  it('still states the account, without the payment, when a payment has no received date', async () => {
    await Item.updateOne({ itemId: 'item-1' }, { $unset: { 'data.Payment Received Date': '' } });

    await run();

    const rendered = statementRender();
    expect(rendered).toBeDefined();
    // Only the invoice's row: the undated payment is neither netted onto it
    // nor given a row of its own.
    expect(JSON.parse(rendered.transactions)).toHaveLength(1);
    expect(closingBalanceOf(rendered)).toBe('$250.00');
  });

  // KAN-286: a payment recorded against an invoice number the participant has
  // no record of has nothing to be applied to. Left on, it gave the ledger a
  // row the ageing never counted and the statement's own reconciliation check
  // threw while rendering.
  it('states the account without a payment that refers to an unknown invoice', async () => {
    await Item.create({
      itemId: 'item-ghost',
      workspaceId: WORKSPACE,
      boardId: BOARD,
      folderId: 'folder-1',
      invoicedBy: 'INV-GHOST',
      data: {
        'Participant Full Name': PARTICIPANT,
        'Amount Received($)': '100',
        'Payment Received Date': '2026-08-21T00:00:00.000Z',
      },
    });

    await run();

    const rendered = statementRender();
    expect(rendered).toBeDefined();
    const rows = JSON.parse(rendered.transactions);
    // The invoice and its own $100 payment; nothing for INV-GHOST.
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.includes('INV-GHOST'))).toBe(false);
    expect(closingBalanceOf(rendered)).toBe('$150.00');
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
    expect(closingBalanceOf(rendered)).toBe('$150.00');
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
        'Payment Received Date': '2026-08-20T00:00:00.000Z',
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

  /**
   * KAN-275: `data['Participant Full Name']` is a free-text copy an operator
   * can hand-edit on the shift itself, independent of who the shift is really
   * for. Live data (workspace 55369, board eNiJpH14PN3, confirmed
   * 2026-09-27/28) had Master Plan items whose own copy had drifted to
   * fragments of the real name ("Maso", "Mas", "Mas K") through repeated test
   * edits, while `data['Participant Profile']` — the same reference already
   * used by invoice generation (ndisInvoiceGeneratorRouteHelpers.js) and the
   * monthly statement (monthlyStatementRouteHelpers.js) to resolve a shift's
   * true participant — still correctly pointed at the real participant's
   * profile record. The invoice for such a shift showed the right participant
   * name (it resolves through the reference, not the free text); its recorded
   * payment did not — `participantPaymentItems` matched only the drifted text
   * and silently dropped the item, so a payment that had actually been
   * recorded looked, on the statement, like it never was.
   */
  it('still finds a payment whose shift has a corrupted Participant Full Name but a correct Participant Profile reference', async () => {
    // item-1 keeps its own drift-free 'Participant Full Name' (unaffected by
    // this case) but loses 'Full Name/Preferred Name' so the profile lookup
    // below is unambiguous about which item is the real profile record.
    await Item.updateOne({ itemId: 'item-1' }, { $unset: { 'data.Full Name/Preferred Name': '' } });
    await Item.create({
      itemId: 'profile-masoud',
      workspaceId: WORKSPACE,
      boardId: BOARD,
      folderId: 'folder-profile',
      data: { 'Full Name/Preferred Name': PARTICIPANT },
    });
    await Item.create({
      itemId: 'item-drifted',
      workspaceId: WORKSPACE,
      boardId: BOARD,
      folderId: 'folder-1',
      invoicedBy: 'INV-1205',
      data: {
        // Stale/corrupted free text — this must not be what payment matching
        // relies on.
        'Participant Full Name': 'Maso',
        // The correct, undamaged reference chain.
        'Participant Profile': ['profile-masoud'],
        'Amount Received($)': '75',
        'Payment Received Date': '2026-08-21T00:00:00.000Z',
      },
    });

    const result = await generateStatementOfAccount({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participant: PARTICIPANT,
      period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-31T23:59:59.999Z' },
      timezone: TZ,
      periodKey: PERIOD_KEY,
      claimStatementNumber: async () => 'SOA-KAN275',
      nameField: 'Participant Full Name',
    });

    expect(result).not.toBeNull();
    const rendered = statementRender();
    expect(rendered).toBeDefined();
    // $250 charged (one invoice, unchanged); $100 from item-1's own payment
    // plus $75 from item-drifted's — found only via its Participant Profile
    // reference — for $175 received and $75 still owing.
    expect(closingBalanceOf(rendered)).toBe('$75.00');
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
    expect(closingBalanceOf(rendered)).toBe('$250.00');
  });

  it('charges a prior-period multi-item invoice once, not once per row', async () => {
    await Item.updateOne({ itemId: 'item-1' }, { $unset: { 'data.Amount Received($)': '' } });
    // Both rows moved to July, before the August period opens. KAN-274: this
    // no longer moves the invoice into an opening balance — it is still its
    // own charge row, dedup still collapsing the two PDFLink rows into one.
    const july = new Date('2026-07-05T00:00:00.000Z');
    await PDFLink.updateOne({ itemId: 'item-1' }, { $set: { createdAt: july } });
    await secondRowOf({ createdAt: july });

    await run();

    const rendered = statementRender();
    expect(rendered).toBeDefined();
    expect(JSON.parse(rendered.transactions)).toHaveLength(1);
    expect(closingBalanceOf(rendered)).toBe('$250.00');
  });
});

/**
 * KAN-229: the statement of account never showed the business logo.
 *
 * The header fell back to text on every statement, while a Tax Invoice raised
 * from the same business rendered its logo correctly — the template had no
 * `logo` field and the generator never called `getLogoData`. Asserted here,
 * where the whole scheduled run is exercised, because the emailed attachment
 * and the downloadable PDF are the same bytes from the same path.
 */
describe('the statement of account letterhead', () => {
  it('embeds the business default logo, read from the store', async () => {
    await generateStatementsForBoard({
      workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
    });

    expect(getS3File).toHaveBeenCalledWith(LOGO_KEY, false);
    expect(statementRender().logo).toBe(LOGO_DATA_URI);
  });

  it('falls back to the text-only header when the business has no logo', async () => {
    await Business.updateOne({ workspaceId: WORKSPACE }, { $unset: { defaultLogo: '' } });

    await generateStatementsForBoard({
      workspaceId: WORKSPACE, boardId: BOARD, slot: SLOT, timezone: TZ, periodKey: PERIOD_KEY,
    });

    expect(statementRender().logo).toBe('');
  });

  /**
   * A logo the store cannot return must not stop the statement.
   *
   * `getLogoData` throws when S3 gives nothing back, and the invoice path
   * lets that throw. A statement cannot afford to: `settledStatementOfAccount`
   * catches whatever the statement throws and carries on with the board, so
   * an unreadable logo object would not fail loudly — it would silently
   * produce no statement of account at all, for every participant, while the
   * budget statement beside it still went out.
   *
   * Driven through `generateStatementOfAccount` rather than the whole run
   * because the budget statement reads the same key first and would consume
   * the override.
   */
  it('still issues the statement when the logo cannot be read', async () => {
    getS3File.mockResolvedValue(null);

    const result = await generateStatementOfAccount({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participant: PARTICIPANT,
      period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-31T23:59:59.999Z' },
      timezone: TZ,
      periodKey: PERIOD_KEY,
      claimStatementNumber: async () => 'SOA-99',
      nameField: 'Participant Full Name',
    });

    expect(result).not.toBeNull();
    expect(statementRender().logo).toBe('');
    expect(await PDFLink.countDocuments({
      periodKey: PERIOD_KEY, type: PDFLINK_TYPE_STATEMENT_OF_ACCOUNT,
    })).toBe(1);
  });
});
