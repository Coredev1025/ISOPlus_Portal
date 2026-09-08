/**
 * Rendering the statement of account.
 *
 * Section 4 of the invoice selection spec. A statement raises no new charges:
 * every figure traces back to an invoice or a payment already recorded, and
 * this module only formats and lays them out.
 *
 * The document is distinct from the NDIS monthly statement in
 * utils/webhookMonthlyStatementPdfHelpers.js, which reports plan budget
 * against services delivered. This one reports money: invoiced, paid, owing,
 * and how overdue.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '@pdfme/generator';
import {
  line, multiVariableText, table, text,
} from '@pdfme/schemas';

import { AGEING_BUCKETS, assertAgeingReconciles } from './statementAgeing.js';
import { assertRunningBalanceReconciles, roundMoney } from './statementTransactions.js';
import { enableRepeatHeadOnTables, formatDateNumericAU } from './invoicePdfSupport.js';
import { DEFAULT_TIMEZONE } from '../constants/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'statementOfAccount.json');

/**
 * Australian currency, with the sign outside the symbol.
 *
 * A refund shows as -$62.50 rather than $-62.50, which is how the sample
 * statement renders an adjustment and how a reader expects to see a credit.
 */
export function formatStatementMoney(value) {
  const amount = roundMoney(value ?? 0);
  const rendered = Math.abs(amount).toLocaleString('en-AU', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return `${amount < 0 ? '-' : ''}$${rendered}`;
}

/**
 * A charge or payment cell, blank when the row is not of that kind.
 *
 * Blank rather than $0.00: a payment row with "$0.00" in the charges column
 * reads as a zero-value charge, and the sample leaves it empty.
 */
const moneyCell = (value) => (Number(value || 0) === 0 ? '' : formatStatementMoney(value));

/**
 * A variables object no multiVariableText will refuse.
 *
 * pdfme's `validateVariables` returns false — and `pdfRender` then draws
 * NOTHING — when any one variable of a block is empty. A participant with no
 * address on their profile therefore lost the entire STATEMENT TO block, name
 * included, so the statement did not say who it was for. A business with no
 * ABN would lose its whole letterhead the same way.
 *
 * A single space rather than a dash or 'N/A': it satisfies the plugin's
 * truthiness test and prints nothing, which is what a missing address should
 * look like on a document that goes to a client.
 */
const variables = (values) => JSON.stringify(
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value || ' '])),
);

/**
 * The transaction rows, as the table plugin wants them.
 */
export function buildTransactionRows(rows, timezone) {
  return rows.map((row) => [
    formatDateNumericAU(row.date, timezone),
    row.reference ?? '',
    row.description ?? '',
    moneyCell(row.charge),
    moneyCell(row.payment),
    formatStatementMoney(row.balance),
  ]);
}

/**
 * Everything the template needs, from a settled statement.
 *
 * Both reconciliation checks run here, before anything is rendered — section
 * 4.3 and 4.4 both say to fail the statement rather than send one that does
 * not add up. Doing it at the render boundary means no caller can skip them.
 */
export function buildStatementInputs(statement, timezone = DEFAULT_TIMEZONE) {
  const {
    ledger, ageing, provider, recipient, meta, bank,
  } = statement;

  assertRunningBalanceReconciles(ledger.rows, ledger.closingBalance);
  assertAgeingReconciles(ageing, ledger.closingBalance);

  // Every multiVariableText field takes a JSON object of its variables, not a
  // bare string — the plugin parses the input and throws on anything else.
  // Only the table and multiVariableText schemas appear here; the label-only
  // blocks are static text in the template and need no input.
  return {
    provider: variables({
      providerName: provider.name,
      providerAbn: provider.abn,
      providerAddress: provider.address,
    }),
    recipient: variables({
      recipientName: recipient.name,
      recipientAddress: recipient.address,
    }),
    metaValues: variables({
      statementNumber: meta.statementNumber,
      statementDate: formatDateNumericAU(meta.statementDate, timezone),
      period: `${formatDateNumericAU(meta.periodStart, timezone)} to ${formatDateNumericAU(meta.periodEnd, timezone)}`,
      accountNumber: meta.accountNumber,
    }),

    summary: JSON.stringify([[
      formatStatementMoney(ledger.openingBalance),
      formatStatementMoney(ledger.totalCharges),
      formatStatementMoney(ledger.totalPayments),
      formatStatementMoney(ledger.closingBalance),
    ]]),
    transactions: JSON.stringify(buildTransactionRows(ledger.rows, timezone)),
    ageing: JSON.stringify([AGEING_BUCKETS.map((b) => formatStatementMoney(ageing[b.key]))]),

    paymentValues: variables({
      bankAccountName: bank.accountName,
      bankName: bank.bankName,
      bankBsb: bank.bsb,
      bankAccountNumber: bank.accountNumber,
      paymentReference: bank.reference,
    }),
    totalDue: JSON.stringify({ totalDue: formatStatementMoney(ledger.closingBalance) }),
  };
}

/**
 * The statement as PDF bytes.
 *
 * `enableRepeatHeadOnTables` is what carries the transaction table's header on
 * to page two, which a statement long enough to wrap needs and the sample
 * demonstrates.
 */
export async function renderStatementOfAccountPdf(statement, timezone = DEFAULT_TIMEZONE) {
  const template = JSON.parse(await readFile(TEMPLATE_PATH, 'utf8'));
  enableRepeatHeadOnTables(template);
  const pdfBytes = await generate({
    template,
    inputs: [buildStatementInputs(statement, timezone)],
    plugins: {
      text, line, table, multiVariableText,
    },
  });
  return Buffer.from(pdfBytes);
}
