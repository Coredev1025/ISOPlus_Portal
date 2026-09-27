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
  image, line, rectangle, table, text,
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
 * A multi-line block, with the lines that have no value left out.
 *
 * The blocks are plain `text` schemas rather than `multiVariableText`, which
 * is what retires the trap the previous template hit: multiVariableText's
 * `validateVariables` returns false when any ONE variable of a block is empty
 * and `pdfRender` then draws nothing, so a participant with no address lost
 * the whole STATEMENT TO block, name included.
 *
 * Dropping the empty lines rather than blanking them keeps the block tight
 * against the top of its box: a business with no ABN gets its address on the
 * second line, not a gap where the ABN would have been.
 */
const block = (...lines) => lines.filter((line_) => String(line_ ?? '').trim() !== '').join('\n');

/** The five ageing cells, in the order the template lays them out. */
const AGEING_FIELDS = Object.freeze([
  'ageingCurrent', 'ageingDays30', 'ageingDays60', 'ageingDays90', 'ageingDays90plus',
]);

/**
 * The transaction rows, as the table plugin wants them.
 *
 * Column order matches the Xero-style reference layout (KAN-273): Date /
 * Activity / Reference / Due Date / Invoice Amount / Payments / Balance AUD.
 * A row with no due date — a payment, or an invoice none could be derived
 * for — gets a blank cell, never a placeholder string.
 */
export function buildTransactionRows(rows, timezone) {
  return rows.map((row) => [
    formatDateNumericAU(row.date, timezone),
    row.description ?? '',
    row.reference ?? '',
    row.dueDate ? formatDateNumericAU(row.dueDate, timezone) : '',
    moneyCell(row.charge),
    moneyCell(row.payment),
    formatStatementMoney(row.balance),
  ]);
}

/**
 * The tear-off "PAYMENT ADVICE" block at the foot of the statement.
 *
 * Mirrors the reference layout's own payment-advice strip: the provider's
 * identity repeated as "To:", the recipient's name as the customer, and the
 * closing balance split into what is overdue versus current — both of which
 * the ageing summary already computes, so this does no arithmetic of its own
 * beyond the subtraction.
 */
function paymentAdviceInputs(providerBlockText, recipientName, ledger, ageing) {
  return {
    paymentAdviceProvider: providerBlockText ? `To: ${providerBlockText}` : '',
    paymentAdviceCustomer: recipientName,
    paymentAdviceOverdue: formatStatementMoney(ledger.closingBalance - ageing.current),
    paymentAdviceCurrent: formatStatementMoney(ageing.current),
    paymentAdviceTotalDue: formatStatementMoney(ledger.closingBalance),
  };
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

  const providerBlockText = block(
    provider.name,
    provider.abn ? `ABN: ${provider.abn}` : '',
    provider.address,
  );

  // Every variable field is a plain `text` schema, so its input is a plain
  // string — newline-separated for the multi-line blocks. The label-only
  // fields (STATEMENT TO, the column heads, the notice) carry their own
  // content in the template and take no input.
  return {
    // KAN-229. Already a data URI by the time it gets here — this module does
    // no I/O. Empty rather than absent when the business has no Default Logo:
    // the image plugin returns without drawing on a falsy value, which is the
    // text-only header every statement had before.
    logo: provider.logo ?? '',

    providerBlock: providerBlockText,
    participantBlock: block(recipient.name, recipient.address),
    metaValues: block(
      meta.statementNumber,
      formatDateNumericAU(meta.statementDate, timezone),
      `${formatDateNumericAU(meta.periodStart, timezone)} to ${formatDateNumericAU(meta.periodEnd, timezone)}`,
      meta.accountNumber,
    ),

    openingBalance: formatStatementMoney(ledger.openingBalance),
    totalCharges: formatStatementMoney(ledger.totalCharges),
    totalPayments: formatStatementMoney(ledger.totalPayments),
    closingBalance: formatStatementMoney(ledger.closingBalance),

    transactions: JSON.stringify(buildTransactionRows(ledger.rows, timezone)),

    ...Object.fromEntries(AGEING_BUCKETS.map(
      (bucket, i) => [AGEING_FIELDS[i], formatStatementMoney(ageing[bucket.key])],
    )),

    paymentValues: block(
      bank.accountName,
      bank.bankName,
      bank.bsb,
      bank.accountNumber,
      bank.reference,
    ),
    amountDue: formatStatementMoney(ledger.closingBalance),

    ...paymentAdviceInputs(providerBlockText, recipient.name, ledger, ageing),
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
    // `rectangle` draws the summary strip and the ageing band. The template
    // uses no multiVariableText, so that plugin is no longer registered.
    // `image` draws the letterhead logo, and must stay registered as long as
    // the template carries the field — pdfme throws on a schema type it has
    // no renderer for, so dropping it fails every statement, not just the
    // ones with a logo.
    plugins: {
      text, line, rectangle, table, image,
    },
  });
  return Buffer.from(pdfBytes);
}
