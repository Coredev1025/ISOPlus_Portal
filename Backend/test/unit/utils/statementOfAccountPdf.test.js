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
    expect(JSON.parse(inputs.provider).providerName).toBe('Provider');
    expect(JSON.parse(inputs.totalDue).totalDue).toBe('$2,427.50');
    expect(JSON.parse(inputs.metaValues).period).toBe('01/09/2025 to 31/08/2026');
  });

  it('renders the ageing row in the declared bucket order', () => {
    const inputs = buildStatementInputs(statementWith(transactions, outstanding), TZ);
    expect(JSON.parse(inputs.ageing)).toEqual([['$1,232.50', '$1,195.00', '$0.00', '$0.00', '$0.00']]);
  });

  it('fills the summary strip from the ledger totals', () => {
    const inputs = buildStatementInputs(statementWith(transactions, outstanding), TZ);
    expect(JSON.parse(inputs.summary)).toEqual([['$0.00', '$2,427.50', '$0.00', '$2,427.50']]);
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
