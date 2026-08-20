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

/** `Paid`, `Awaiting Payment`, `Unpaid`, `Written Off`. */
export const STATEMENT_PAYMENT_STATUS = 'Payment Status';

/** How much has been received against this service record, in dollars. */
export const STATEMENT_AMOUNT_RECEIVED = 'Amount Received($)';

/**
 * The date the payment is placed on.
 *
 * **Unconfirmed.** The attribute exists and is a date, but its name reads as
 * easily as "the date the payer received the invoice" as "the date we received
 * the money", and every row was empty when it was checked, so there was no data
 * to settle it. Masoud has been asked which it is.
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
