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
 * The date the payment is placed on: the ISO+ attribute "Payment Received
 * Date" (KAN-284; it was called "Invoice Received Date" before ISO+ renamed it).
 *
 * Verified against the running product: the attribute is configured as a date
 * with format `31/03/2019` and "Include a Time Field" switched off, so it is
 * **date-only**. Two consequences. Ordering within a day cannot come from this
 * field, which is why `orderTransactions` falls back to a sequence tiebreaker
 * — without it, a payment and an invoice on the same day could swap between
 * renders. And a day is the finest granularity a statement row can claim,
 * which matches the sample.
 *
 * A payment with an amount but no date here is bad data and is left off the
 * statement entirely (KAN-285): see `collectPayments` in utils/statementLedger.js.
 *
 * Touchpoints: utils/statementLedger.js (collectPayments).
 */
export const STATEMENT_PAYMENT_DATE = 'Payment Received Date';

/** Payment statuses that mean no more money is coming for this record. */
export const PAYMENT_STATUS_WRITTEN_OFF = 'Written Off';
