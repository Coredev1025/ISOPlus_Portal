/**
 * The ISO+ attributes the statement of account reads payments from.
 *
 * Payments are entered manually in ISO+ and reach us through the ordinary item
 * sync, so they arrive as attributes on the service record rather than as a
 * collection of their own. Xero is not read — the integration is write-only
 * (createInvoice / createQuote / createPurchaseOrder), and syncing payments
 * back from it is a later improvement, deliberately out of scope.
 *
 * Verified against the Shift Planning and Reporting Log board on
 * app.isoplus.online, where these sit together as a group.
 */

/**
 * The payment state of a service record.
 *
 * **The value set is not the same on every board**, which the fixtures in this
 * repo do not show. The NDIS side uses `Paid`, `Awaiting Payment`, `Unpaid`
 * and `Written Off` — those are what `test/fixtures` carry and what the
 * portal's Invoice Generator renders. The Care Management shift board in the
 * running product instead carries claim-workflow values: every one of its 46
 * rows reads `Gov Claim Submitted`, and `Participant Invoiced` also appears.
 *
 * So this attribute cannot be treated as a two-state paid/unpaid flag. The
 * statement does not currently branch on it — money comes from
 * STATEMENT_AMOUNT_RECEIVED, which is a number and means the same thing on
 * every board — and that is deliberate. Anything that starts reading this
 * field has to handle both vocabularies, or enumerate them per board type the
 * way constants/invoiceSelection.js does for the selection statuses.
 */
export const STATEMENT_PAYMENT_STATUS = 'Payment Status';

/** How much has been received against this service record, in dollars. */
export const STATEMENT_AMOUNT_RECEIVED = 'Amount Received($)';

/**
 * The date the payment is placed on.
 *
 * Verified against the running product: the attribute is configured as a date
 * with format `31/03/2019` and "Include a Time Field" switched off, so it is
 * **date-only**. Two consequences. Ordering within a day cannot come from this
 * field, which is why `orderTransactions` falls back to a sequence tiebreaker
 * — without it, a payment and an invoice on the same day could swap between
 * renders. And a day is the finest granularity a statement row can claim,
 * which matches the sample.
 *
 * **What it means is still unconfirmed.** The name reads as easily as "the date
 * the payer received the invoice" as "the date we received the money". ISO+
 * attributes carry no description field — the edit dialog exposes only name,
 * format and the time toggle — and every row was empty on the board checked, so
 * neither the definition nor the data settles it. Masoud has been asked.
 *
 * It is a single named constant precisely so that answer costs one line to
 * apply. If it turns out not to be the payment date, the fallback is
 * `buildStatementLedger` with `datedPayments: false`, which nets each payment
 * against its invoice and drops the dated payment rows and the running balance
 * — see the module for what that changes.
 */
export const STATEMENT_PAYMENT_DATE = 'Invoice Received Date';

/** Payment statuses that mean no more money is coming for this record. */
export const PAYMENT_STATUS_WRITTEN_OFF = 'Written Off';
