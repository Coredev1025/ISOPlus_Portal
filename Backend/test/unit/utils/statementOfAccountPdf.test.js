import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from '@pdfme/pdf-lib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildStatementInputs,
  buildTransactionRows,
  formatStatementMoney,
  renderStatementOfAccountPdf,
} from '../../../src/utils/statementOfAccountPdf.js';
import { buildRunningBalance } from '../../../src/utils/statementTransactions.js';
import { buildAgeingSummary } from '../../../src/utils/statementAgeing.js';

const TZ = 'Australia/Sydney';

const statementWith = (transactions, outstanding, openingBalance = 0) => {
  const ledger = buildRunningBalance(openingBalance, transactions);
  return {
    ledger,
    ageing: buildAgeingSummary(outstanding, '2026-08-31T00:00:00.000+10:00', TZ),
    provider: {
      name: 'Provider', abn: '00 000 000 000', address: '1 St', logo: '',
    },
    recipient: { name: 'Participant', address: '2 Rd' },
    meta: {
      statementNumber: 'STM-1',
      statementDate: '2026-08-31T00:00:00.000+10:00',
      periodStart: '2025-09-01',
      periodEnd: '2026-08-31',
      accountNumber: 'ACC-1',
    },
    bank: {
      accountName: 'Provider', bankName: 'Bank', bsb: '000-000', accountNumber: '1', reference: 'ACC-1',
    },
  };
};

describe('formatStatementMoney', () => {
  it('groups thousands and always shows cents', () => {
    expect(formatStatementMoney(12300.5)).toBe('$12,300.50');
    expect(formatStatementMoney(0)).toBe('$0.00');
  });

  it('puts the sign outside the symbol for a credit', () => {
    // -$62.50, the way the sample renders an Adjustment (Refund), rather than
    // the $-62.50 that toLocaleString would give.
    expect(formatStatementMoney(-62.5)).toBe('-$62.50');
  });
});

// Column order matches the Xero-style reference layout (KAN-273):
// Date / Activity / Reference / Due Date / Invoice Amount / Payments / Balance AUD.
describe('buildTransactionRows', () => {
  it('leaves the opposite money column blank rather than printing $0.00', () => {
    // A payment row showing "$0.00" under Invoice Amount reads as a
    // zero-value charge.
    const rows = buildTransactionRows([
      {
        date: '2025-09-08', reference: 'PMT-1', description: 'Payment received', charge: 0, payment: 284.2, balance: 0,
      },
    ], TZ);
    expect(rows[0][4]).toBe('');
    expect(rows[0][5]).toBe('$284.20');
  });

  it('shows a refund as a negative charge, not as a payment', () => {
    const rows = buildTransactionRows([
      {
        date: '2025-12-18', reference: 'CRN-1', description: 'Adjustment (Refund)', charge: -62.5, payment: 0, balance: 870,
      },
    ], TZ);
    expect(rows[0][4]).toBe('-$62.50');
    expect(rows[0][5]).toBe('');
  });

  it('orders the columns Date / Activity / Reference / Due Date / Invoice Amount / Payments / Balance AUD', () => {
    const rows = buildTransactionRows([
      {
        date: '2026-07-01',
        reference: 'INV-1188',
        description: 'Care Management - SaH - June services',
        dueDate: '2026-07-15',
        charge: 980.4,
        payment: 0,
        balance: 980.4,
      },
    ], TZ);
    expect(rows[0]).toEqual([
      '01/07/2026',
      'Care Management - SaH - June services',
      'INV-1188',
      '15/07/2026',
      '$980.40',
      '',
      '$980.40',
    ]);
  });

  // KAN-273: the annotated bad output showed a literal "XX/XX/XX" placeholder
  // in the due-date column. A row with no due date (a payment, or an invoice
  // whose due date could not be derived) must render a blank cell instead of
  // any placeholder text.
  it('leaves the due date blank rather than a placeholder when the row has none', () => {
    const rows = buildTransactionRows([
      {
        date: '2025-09-08', reference: 'PMT-1', description: 'Payment received', charge: 0, payment: 284.2, balance: 0,
      },
    ], TZ);
    expect(rows[0][3]).toBe('');
  });
});

describe('buildStatementInputs', () => {
  const transactions = [
    {
      date: '2026-07-01', reference: 'INV-1160', description: 'Jul services', charge: 1195, payment: 0, sequence: 1,
    },
    {
      date: '2026-08-01', reference: 'INV-1161', description: 'Aug services', charge: 1232.5, payment: 0, sequence: 2,
    },
  ];
  const outstanding = [
    { dueDate: '2026-08-15', amount: 1195 },
    { dueDate: '2026-09-14', amount: 1232.5 },
  ];

  it('produces a JSON object for each multiVariableText field, not a bare string', () => {
    // The plugin parses the input and throws on anything that is not JSON.
    const inputs = buildStatementInputs(statementWith(transactions, outstanding), TZ);
    expect(inputs.providerBlock.split('\n')[0]).toBe('Provider');
    expect(inputs.amountDue).toBe('$2,427.50');
    expect(inputs.metaValues.split('\n')[2]).toBe('01/09/2025 to 31/08/2026');
  });

  // The ageing summary is five separate text fields over a rectangle rather
  // than a table: it is fixed at five columns and never grows, and a second
  // table schema on the page risks the padding/overlap bug that shows up when
  // the transaction table spans pages.
  it('renders the ageing cells in the declared bucket order', () => {
    const inputs = buildStatementInputs(statementWith(transactions, outstanding), TZ);
    expect([
      inputs.ageingCurrent,
      inputs.ageingDays30,
      inputs.ageingDays60,
      inputs.ageingDays90,
      inputs.ageingDays90plus,
    ]).toEqual(['$1,232.50', '$1,195.00', '$0.00', '$0.00', '$0.00']);
  });

  it('fills the summary strip from the ledger totals', () => {
    const inputs = buildStatementInputs(statementWith(transactions, outstanding), TZ);
    expect([
      inputs.openingBalance,
      inputs.totalCharges,
      inputs.totalPayments,
      inputs.closingBalance,
    ]).toEqual(['$0.00', '$2,427.50', '$0.00', '$2,427.50']);
  });

  it('refuses to build a statement whose ageing does not match the balance', () => {
    const broken = statementWith(transactions, [{ dueDate: '2026-08-15', amount: 1 }]);
    expect(() => buildStatementInputs(broken, TZ)).toThrow(/ageing does not reconcile/i);
  });

  it('refuses to build a statement whose rows do not reach the closing balance', () => {
    const broken = statementWith(transactions, outstanding);
    broken.ledger.closingBalance = 9999;
    expect(() => buildStatementInputs(broken, TZ)).toThrow(/running balance does not reconcile/i);
  });

  // KAN-273: the annotated bad output showed a "BALANCE DUE" figure that did
  // not reconcile with the transaction rows shown alongside it. `amountDue`
  // must always be the same figure as `closingBalance` — never a separately
  // sourced or stale value — for exactly the same statement.
  it('states the same figure for amountDue and closingBalance, always', () => {
    const inputs = buildStatementInputs(statementWith(transactions, outstanding), TZ);
    expect(inputs.amountDue).toBe(inputs.closingBalance);
  });
});

/**
 * KAN-273: the tear-off "PAYMENT ADVICE" block the Xero-style reference
 * layout carries at the foot of the statement — a repeat of the provider's
 * identity, the recipient's name, and the balance split into what is overdue
 * versus current, all derived from figures the statement already computes.
 */
describe('buildStatementInputs — payment advice block', () => {
  const transactions = [
    {
      date: '2026-07-05', reference: 'INV-3001', description: 'Jul services', charge: 1000, payment: 0, sequence: 1,
    },
  ];
  const outstanding = [{ dueDate: '2026-07-19', amount: 1000 }];

  it('repeats the provider identity as "To:"', () => {
    const inputs = buildStatementInputs(statementWith(transactions, outstanding), TZ);
    expect(inputs.paymentAdviceProvider).toBe('To: Provider\nABN: 00 000 000 000\n1 St');
  });

  it('carries the recipient name through as the customer', () => {
    const inputs = buildStatementInputs(statementWith(transactions, outstanding), TZ);
    expect(inputs.paymentAdviceCustomer).toBe('Participant');
  });

  it('splits the balance into overdue and current, summing to the total due', () => {
    const inputs = buildStatementInputs(statementWith(transactions, outstanding), TZ);
    // The invoice fell due 19/07/2026 and the statement (per statementWith) is
    // struck 31/08/2026, so the whole $1,000.00 is overdue and nothing is
    // current.
    expect(inputs.paymentAdviceOverdue).toBe('$1,000.00');
    expect(inputs.paymentAdviceCurrent).toBe('$0.00');
    expect(inputs.paymentAdviceTotalDue).toBe('$1,000.00');
  });

  it('leaves "To:" off entirely when there is no provider identity at all', () => {
    const statement = statementWith(transactions, outstanding);
    statement.provider = { name: '', abn: '', address: '' };
    expect(buildStatementInputs(statement, TZ).paymentAdviceProvider).toBe('');
  });
});

describe('renderStatementOfAccountPdf', () => {
  const manyRows = (count) => Array.from({ length: count }, (_, i) => ({
    date: `2026-0${(i % 8) + 1}-01`,
    reference: `INV-${1100 + i}`,
    description: 'Care Management - NDIS - Certification - monthly services',
    charge: 100,
    payment: 0,
    sequence: i,
  }));

  it('renders a PDF from the committed template', async () => {
    // Exercises pdfme itself, not just the inputs. Every schema has to sit
    // inside the basePdf padding box, and a schema above the top padding makes
    // the dynamic-table pass compute a page index that does not exist — which
    // fails for a single row, so no amount of input-shape testing finds it.
    const bytes = await renderStatementOfAccountPdf(
      statementWith(manyRows(1), [{ dueDate: '2026-09-14', amount: 100 }]), TZ,
    );
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('paginates when the transaction list outgrows one page', async () => {
    const rows = manyRows(40);
    const bytes = await renderStatementOfAccountPdf(
      statementWith(rows, [{ dueDate: '2026-09-14', amount: 4000 }]), TZ,
    );
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    // Two pages of content rather than one clipped one. Counted by parsing the
    // document — pdfme compresses its objects into streams, so the page
    // dictionaries are not greppable in the raw bytes.
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('refuses to render a statement that does not reconcile', async () => {
    await expect(renderStatementOfAccountPdf(
      statementWith(manyRows(1), [{ dueDate: '2026-09-14', amount: 999 }]), TZ,
    )).rejects.toThrow(/does not reconcile/i);
  });
});

/**
 * The blocks are plain `text` schemas carrying newline-separated lines, not
 * `multiVariableText`.
 *
 * That is what retires the trap this suite was written for: multiVariableText's
 * `validateVariables` returns false when ANY one variable of a block is empty,
 * and `pdfRender` then draws NOTHING — a participant with no address on their
 * profile lost the whole STATEMENT TO block, name included, so the statement
 * did not say who it was for. A plain text field cannot fail that way, so the
 * requirement is now the simpler one: the lines that do have values still
 * render, and a missing one leaves an empty line rather than a placeholder.
 */
describe('buildStatementInputs — a missing value must not blank its block', () => {
  const statement = {
    provider: { name: 'Dev-Test11', abn: '', address: '' },
    recipient: { name: 'Jane Smith', address: '' },
    meta: {
      statementNumber: 'STM-23',
      statementDate: '2026-08-31T00:00:00.000Z',
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-08-31T00:00:00.000Z',
      accountNumber: 'Jane Smith',
    },
    ledger: {
      rows: [], openingBalance: 0, closingBalance: 0, totalCharges: 0, totalPayments: 0,
    },
    ageing: {
      current: 0, d1to30: 0, d31to60: 0, d61to90: 0, d90plus: 0,
    },
    bank: {
      accountName: 'Dev-Test11', bankName: '', bsb: '', accountNumber: '', reference: 'STM-23',
    },
  };

  it('still shows the values that are there', () => {
    const inputs = buildStatementInputs(statement);
    expect(inputs.participantBlock.split('\n')[0]).toBe('Jane Smith');
    expect(inputs.providerBlock.split('\n')[0]).toBe('Dev-Test11');
  });

  // Nothing visible, not a dash or "N/A": the statement must not print a
  // placeholder at a client, it must simply leave the line empty.
  it('substitutes nothing visible for the missing value', () => {
    const inputs = buildStatementInputs(statement);
    expect(inputs.participantBlock).toBe('Jane Smith');
    expect(inputs.providerBlock).toBe('Dev-Test11');
  });

  // An absent ABN must not leave a bare "ABN:" label stranded on the letterhead.
  it('omits the ABN line entirely when there is no ABN', () => {
    const inputs = buildStatementInputs(statement);
    expect(inputs.providerBlock).not.toMatch(/ABN/);
  });

  it('labels the ABN when there is one', () => {
    const inputs = buildStatementInputs({
      ...statement,
      provider: { name: 'Dev-Test11', abn: '11 222 333 444', address: '' },
    });
    expect(inputs.providerBlock).toBe('Dev-Test11\nABN: 11 222 333 444');
  });
});

/**
 * KAN-229: the statement of account was the one document type with no logo.
 *
 * Every other template — invoice.json, NDISinvoice.json, monthlyStatement.json
 * and five more — carries a `logo` image field, and every other generator
 * calls `getLogoData(business)`. This one carried neither, so a business with
 * a Default Logo set got a text-only header on its statements and on nothing
 * else. Both halves are asserted: the field has to exist in the committed
 * template, and the renderer has to actually draw what is put in it.
 */

const TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'src', 'assets', 'statementOfAccount.json',
);

/**
 * How many images the rendered document embeds.
 *
 * Counted off the parsed object graph rather than the raw bytes, for the same
 * reason the pagination test parses the document: pdfme compresses its
 * objects, so an XObject dictionary is not greppable.
 *
 * The soft masks are subtracted. A PNG with an alpha channel — which a logo
 * on a transparent background is — embeds as two image streams, the picture
 * and its /SMask, and counting both would make "one logo" read as two and
 * tie the assertion to the fixture's colour type rather than to the logo.
 */
async function countEmbeddedImages(bytes) {
  const doc = await PDFDocument.load(bytes);
  const image = PDFName.of('Image');
  const refs = [];
  const masks = new Set();
  doc.context.enumerateIndirectObjects().forEach(([ref, object]) => {
    if (!(object instanceof PDFRawStream)) return;
    if (object.dict.get(PDFName.of('Subtype')) !== image) return;
    refs.push(ref.toString());
    const mask = object.dict.get(PDFName.of('SMask'));
    if (mask) masks.add(mask.toString());
  });
  return refs.filter((ref) => !masks.has(ref)).length;
}

// A 2x2 PNG. The pixels do not matter; that a real image is embedded does.
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8DAwMDAwMSABDACACHiAQqbCBjgAAAAAElFTkSuQmCC';

describe('the committed statement of account template', () => {
  it('carries a logo field, like every other document template', async () => {
    const template = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
    const fields = template.schemas.flat();
    const logo = fields.find((field) => field.name === 'logo');
    expect(logo).toBeDefined();
    expect(logo.type).toBe('image');
  });

  // The header is drawn inside the basePdf padding box; a field above the top
  // padding is what breaks the dynamic-table page pass.
  it('places the logo inside the page margins', async () => {
    const template = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
    const [top, right, bottom, left] = template.basePdf.padding;
    const logo = template.schemas.flat().find((field) => field.name === 'logo');
    expect(logo.position.y).toBeGreaterThanOrEqual(top);
    expect(logo.position.x).toBeGreaterThanOrEqual(left);
    expect(logo.position.x + logo.width).toBeLessThanOrEqual(template.basePdf.width - right);
    expect(logo.position.y + logo.height).toBeLessThanOrEqual(template.basePdf.height - bottom);
  });

  /**
   * KAN-273: the template's own layout, checked structurally rather than by
   * rendering pixels — the Xero-style reference statements (Purple Lotus,
   * Westpoint Group) all share this title, these table columns and this
   * "BALANCE DUE AUD" wording.
   */
  it('titles the document STATEMENT, matching the reference layout', async () => {
    const template = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
    const title = template.schemas.flat().find((field) => field.name === 'title');
    expect(title.content).toBe('STATEMENT');
  });

  it('lays out the activity table as Date / Activity / Reference / Due Date / Invoice Amount / Payments / Balance AUD', async () => {
    const template = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
    const table = template.schemas.flat().find((field) => field.name === 'transactions');
    expect(table.head).toEqual([
      'Date', 'Activity', 'Reference', 'Due Date', 'Invoice Amount', 'Payments', 'Balance AUD',
    ]);
    expect(table.headWidthPercentages).toHaveLength(7);
    expect(table.headWidthPercentages.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('labels the total "BALANCE DUE AUD", matching the reference wording', async () => {
    const template = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
    const label = template.schemas.flat().find((field) => field.name === 'amountDueLabel');
    expect(label.content).toBe('BALANCE DUE AUD');
  });

  // Both reference statements carry a tear-off "PAYMENT ADVICE" strip at the
  // foot of the page; the previous template had no equivalent at all.
  it('carries a tear-off PAYMENT ADVICE section, like the reference layout', async () => {
    const template = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
    const fields = template.schemas.flat();
    const title = fields.find((field) => field.name === 'paymentAdviceTitle');
    expect(title).toBeDefined();
    expect(title.content).toBe('PAYMENT ADVICE');
    for (const name of ['paymentAdviceProvider', 'paymentAdviceCustomer', 'paymentAdviceOverdue', 'paymentAdviceCurrent', 'paymentAdviceTotalDue']) {
      expect(fields.find((field) => field.name === name), `expected a ${name} field`).toBeDefined();
    }
  });

  // Every non-static field the tear-off section binds to must fit inside the
  // page margins, for the same reason the logo check exists.
  it('keeps every payment advice field inside the page margins', async () => {
    const template = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
    const [top, right, bottom, left] = template.basePdf.padding;
    const adviceFields = template.schemas.flat().filter((field) => field.name?.startsWith('paymentAdvice') || field.name === 'tearOffRule');
    expect(adviceFields.length).toBeGreaterThan(0);
    for (const field of adviceFields) {
      expect(field.position.y).toBeGreaterThanOrEqual(top);
      expect(field.position.x).toBeGreaterThanOrEqual(left);
      expect(field.position.x + field.width).toBeLessThanOrEqual(template.basePdf.width - right);
      expect(field.position.y + field.height).toBeLessThanOrEqual(template.basePdf.height - bottom);
    }
  });
});

describe('the statement of account logo', () => {
  const rows = [{
    date: '2026-07-01', reference: 'INV-1160', description: 'Jul services', charge: 100, payment: 0, sequence: 1,
  }];
  const outstanding = [{ dueDate: '2026-09-14', amount: 100 }];
  const withLogo = (logo) => {
    const statement = statementWith(rows, outstanding);
    statement.provider.logo = logo;
    return statement;
  };

  it('passes the provider logo through to the template input', () => {
    expect(buildStatementInputs(withLogo(LOGO), TZ).logo).toBe(LOGO);
  });

  // Empty, not undefined: the image plugin returns without drawing on a falsy
  // value, which is what keeps a business with no Default Logo on the
  // text-only header it has today rather than failing the render.
  it('is empty when the business has no default logo', () => {
    expect(buildStatementInputs(statementWith(rows, outstanding), TZ).logo).toBe('');
  });

  it('is embedded in the rendered PDF', async () => {
    const bytes = await renderStatementOfAccountPdf(withLogo(LOGO), TZ);
    expect(await countEmbeddedImages(bytes)).toBe(1);
  });

  // The other half of the same requirement: no logo must not mean a blank box
  // or a sample image, it must mean no image at all.
  it('embeds nothing when there is no logo', async () => {
    const bytes = await renderStatementOfAccountPdf(statementWith(rows, outstanding), TZ);
    expect(await countEmbeddedImages(bytes)).toBe(0);
  });
});
