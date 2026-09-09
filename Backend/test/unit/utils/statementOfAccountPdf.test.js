import { describe, it, expect } from 'vitest';
import { PDFDocument } from '@pdfme/pdf-lib';

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
    provider: { name: 'Provider', abn: '00 000 000 000', address: '1 St' },
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

describe('buildTransactionRows', () => {
  it('leaves the opposite money column blank rather than printing $0.00', () => {
    // A payment row showing "$0.00" under Charges reads as a zero-value
    // charge.
    const rows = buildTransactionRows([
      {
        date: '2025-09-08', reference: 'PMT-1', description: 'Payment received', charge: 0, payment: 284.2, balance: 0,
      },
    ], TZ);
    expect(rows[0][3]).toBe('');
    expect(rows[0][4]).toBe('$284.20');
  });

  it('shows a refund as a negative charge, not as a payment', () => {
    const rows = buildTransactionRows([
      {
        date: '2025-12-18', reference: 'CRN-1', description: 'Adjustment (Refund)', charge: -62.5, payment: 0, balance: 870,
      },
    ], TZ);
    expect(rows[0][3]).toBe('-$62.50');
    expect(rows[0][4]).toBe('');
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
