import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * What actually reaches the invoice PDF.
 *
 * Two review findings landed together and looked like one bug. Arnold asked
 * why a generated invoice had no logo and no bank details; Masoud said the
 * content "seems to be all zeros". They have different causes and different
 * fixes, and both are invisible to a test that only checks a document was
 * produced — which is what every test here did before.
 *
 * Masoud's invoice came off the Age Care path, not this one; its guard is
 * covered in test/unit/utils/webhookParticipantTaxPdfHelpers.test.js. What
 * this file adds is the values: the logo and the bank details a client needs
 * in order to pay, asserted where they are set rather than where they are
 * drawn.
 *
 * pdfme is mocked here so the inputs it is handed can be read directly. The
 * real renderer is exercised in
 * test/unit/services/automation.ndisInvoiceGeneratorPdf.test.js; asserting the
 * rendered bytes would prove less than asserting the values, and would break
 * on every template tweak.
 */

const generatedInputs = [];

vi.mock('@pdfme/generator', () => ({
  generate: vi.fn(async ({ inputs }) => {
    generatedInputs.push(inputs[0]);
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  }),
}));

const Business = (await import('../../src/models/Business.js')).default;
const Item = (await import('../../src/models/Item.js')).default;
const InvoiceNumber = (await import('../../src/models/InvoiceNumber.js')).default;
const { generateNdisInvoiceGeneratorPdf } = await import(
  '../../src/services/automation/ndisInvoiceGeneratorPdf.js'
);

const WS = 'ws-branding';
const BOARD = 'board-branding';
const SP_ID = '11111111-bbbb-4111-8111-111111111111';
const SP_FREE_ID = '11111111-bbbb-4111-8111-111111111112';
const PP_ID = '22222222-bbbb-4111-8111-222222222222';
const SUPPORT_CAT_ID = '66666666-bbbb-4111-8111-666666666666';
const LOGO_KEY = 'logos/ws-branding/logo.png';

const BANK = {
  accountName: 'ISO Consulting Services',
  bankName: 'Example Bank',
  bsb: '062-000',
  accountNumber: '12345678',
};

// A one-pixel PNG. The bytes do not matter — that a real buffer is read from
// the store, base64'd and handed to the template as a data URI does.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A master item whose direct-support value decides what the invoice bills. */
const master = (itemId, servicePlanId, value) => ({
  workspaceId: WS,
  boardId: BOARD,
  folderId: 'f-master',
  itemId,
  data: {
    'Timesheet Approval': 'Approved',
    'Job Status': 'Completed',
    'Payment Status': 'Unpaid',
    'Service Plan': [{ id: servicePlanId }],
    'Participant Profile': [{ id: PP_ID }],
    'Scheduled Shift Start Date & Time': '2026-01-14T21:00:00.000Z',
    'Actual Shift Start Date and Time': '2026-01-14T22:00:00.000Z',
    'Actual Shift End Date and Time': '2026-01-15T00:30:00.000Z',
    'Actual Shift Duration(Hr.)': '2.5',
    'Direct Support Value($) - Time Based Support': value,
  },
});

describe('what reaches the invoice PDF', () => {
  const saved = {};
  let root;

  beforeEach(async () => {
    generatedInputs.length = 0;
    saved.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE;
    saved.LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT;
    process.env.ISOPLUS_OFFLINE = '1';
    root = mkdtempSync(join(tmpdir(), 'branding-'));
    process.env.LOCAL_FILE_ROOT = root;

    const logoPath = join(root, LOGO_KEY);
    mkdirSync(dirname(logoPath), { recursive: true });
    writeFileSync(logoPath, PNG);

    await Business.create({
      workspaceId: WS,
      name: 'ISO Consulting Services',
      abn: '98 765 432 109',
      defaultLogo: LOGO_KEY,
      address: {
        street: '2 Fixture Ave', suburb: 'Demoville', state: 'NSW', postcode: '2001', country: 'Australia',
      },
      bankDetails: BANK,
      documentNumbering: {
        invoice: { prefix: 'INV-', nextNumber: 1006 },
        quote: { prefix: 'QT-', nextNumber: 1 },
        purchaseOrder: { prefix: 'PO-', nextNumber: 1 },
      },
    });

    await Item.create({
      workspaceId: WS, boardId: 'cat-board', folderId: 'f-cat', itemId: SUPPORT_CAT_ID,
      data: { 'Support Item Number': '01_011_0107_1_1', 'Support Item Name': 'Assistance' },
    });
    await Item.create({
      workspaceId: WS, boardId: 'cat-board', folderId: 'f-cat', itemId: SP_ID,
      data: {
        'Direct Support Item Number': [{ id: SUPPORT_CAT_ID, name: 'Assistance' }],
        'Unit (Direct Support)': 'Hour(H)',
        'Agreed Unit Price for Direct Support ($)': '70.00',
      },
    });
    await Item.create({
      workspaceId: WS, boardId: 'cat-board', folderId: 'f-cat', itemId: SP_FREE_ID,
      data: {
        'Direct Support Item Number': [{ id: SUPPORT_CAT_ID, name: 'Assistance' }],
        'Unit (Direct Support)': 'Hour(H)',
        'Agreed Unit Price for Direct Support ($)': '0.00',
      },
    });
    await Item.create({
      workspaceId: WS, boardId: 'cat-board', folderId: 'f-cat', itemId: PP_ID,
      data: { 'Full Name/Preferred Name': 'Samuel Rivers', 'NDIS Number': '430123456' },
    });
  });

  afterEach(async () => {
    process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
    process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  describe('the business branding Arnold asked about', () => {
    it('embeds the logo as a data URI read from the store', async () => {
      await Item.create(master('mp-brand-1', SP_ID, '175.00'));

      await generateNdisInvoiceGeneratorPdf({
        workspaceId: WS, boardId: BOARD, masterItemIds: ['mp-brand-1'],
      });

      expect(generatedInputs).toHaveLength(1);
      expect(generatedInputs[0].logo).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    });

    it('puts every bank field on the document, so the invoice can be paid', async () => {
      await Item.create(master('mp-brand-2', SP_ID, '175.00'));

      await generateNdisInvoiceGeneratorPdf({
        workspaceId: WS, boardId: BOARD, masterItemIds: ['mp-brand-2'],
      });

      const bank = JSON.parse(generatedInputs[0]['Bank Details']);
      expect(bank).toMatchObject({
        'Account Name': BANK.accountName,
        'Bank Name': BANK.bankName,
        BSB: BANK.bsb,
        'Account Number': BANK.accountNumber,
      });
      // The payment reference is the invoice number, not the prefix alone —
      // a reference of "INV-" reconciles against nothing.
      expect(bank['invoice Number']).toMatch(/^INV-\d+$/);
    });
  });

  // Not the INV-1005 reproduction — that invoice came off the Age Care path,
  // and its guard is covered in
  // test/unit/utils/webhookParticipantTaxPdfHelpers.test.js
  // ("answers 400 when the rows exist but bill nothing"), which fails against
  // the old row-counting guard.
  //
  // Here the zero row never becomes a row at all, so the invoice is empty
  // before any total is computed. Worth holding anyway: it is the outcome
  // that matters to a participant, and it is what stops the NDIS path
  // regressing into issuing $0.00 documents by a different route.
  describe('an NDIS invoice with nothing to bill', () => {
    it('does not issue an invoice that bills nothing', async () => {
      // A zero-priced record produces no line here (the row builder emits one
      // only for a positive amount), so the run ends empty rather than
      // rendering a $0.00 document.
      await Item.create(master('mp-zero-1', SP_FREE_ID, '0.00'));

      const result = await generateNdisInvoiceGeneratorPdf({
        workspaceId: WS, boardId: BOARD, masterItemIds: ['mp-zero-1'],
      });

      expect(result).toEqual({ empty: true });
      // Never rendered, so nothing was uploaded and nothing was emailed.
      expect(generatedInputs).toHaveLength(0);
    });

    it('leaves the items of an empty run billable', async () => {
      // The failure that made this expensive: a $0.00 invoice still marked its
      // items invoiced, so the work was excluded from every future run and the
      // money was never billed. Whatever stops the document, the items must
      // stay billable — that is the half that costs real money.
      await Item.create(master('mp-zero-2', SP_FREE_ID, '0.00'));

      await generateNdisInvoiceGeneratorPdf({
        workspaceId: WS, boardId: BOARD, masterItemIds: ['mp-zero-2'],
      });

      const item = await Item.findOne({ workspaceId: WS, boardId: BOARD, itemId: 'mp-zero-2' }).lean();
      expect(item.invoicedBy ?? null).toBeNull();
      expect(await InvoiceNumber.countDocuments({ workspaceId: WS, itemId: 'mp-zero-2' })).toBe(0);
    });

    it('still bills a mixed set, and the zero row never becomes a line', async () => {
      // A $0.00 record belonging to someone with real billable work does not
      // stop the invoice. On this path it also never appears on it: the NDIS
      // row builder emits a line only when the amount is positive
      // (ndisLegacyMasterPlanServiceHelpers.js:276), so a zero row is dropped
      // before the total guard ever sees it.
      //
      // The Age Care path differs — it does emit the $0.00 line, because the
      // service record exists and belongs to the participant. Both are
      // defensible; they are not the same, and a reader comparing two
      // invoices should know which one they are holding.
      await Item.create(master('mp-mixed-paid', SP_ID, '175.00'));
      await Item.create(master('mp-mixed-free', SP_FREE_ID, '0.00'));

      const result = await generateNdisInvoiceGeneratorPdf({
        workspaceId: WS, boardId: BOARD, masterItemIds: ['mp-mixed-paid', 'mp-mixed-free'],
      });

      expect(result.empty).toBeUndefined();
      expect(result.invoiceTotal).toBeGreaterThan(0);
      expect(JSON.parse(generatedInputs[0].orders)).toHaveLength(1);
    });
  });
});
