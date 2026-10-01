/**
 * Where a generated document lives in S3, and how long a link to one is good
 * for. Each entry records its touchpoints — the modules that read it — so
 * changing a value tells you what it reaches without a grep.
 *
 * This file imports nothing, deliberately, so a util and a route can both read
 * it without risking a cycle.
 */

/**
 * Generated documents go in the NON-PUBLIC bucket (AWS_BUCKET), never
 * AWS_BUCKET_PUBLIC. They are client billing documents: invoices, quotes and
 * statements carrying names, addresses and amounts, at keys built from
 * sequential invoice numbers — enumerable by anyone who guesses one. The
 * public bucket exists for assets that are meant to be world-readable, such as
 * a business logo.
 *
 * `uploadFileToS3`/`getS3FileUrl` take this as their `publicRead` argument, so
 * it is spelled out here rather than as a bare `false` at nine call sites.
 *
 * Touchpoints: services/automation/ndisInvoiceGeneratorPdf.js,
 * utils/webhookMonthlyStatementPdfHelpers.js,
 * utils/webhookParticipantTaxPdfHelpers.js, utils/webhookNdisPdfHandlers.js,
 * routes/webhook.js, routes/pdfLink.js (POST /file streams via getS3File).
 */
export const GENERATED_DOCUMENT_PUBLIC_READ = false;

/**
 * The top-level folder every generated document sits under.
 *
 * Touchpoints: utils/s3OutputKey.js (buildOutputKey).
 */
export const OUTPUT_PREFIX = 'output';

/**
 * The per-type folder, one level below the board. The values are the folder
 * names already in the buckets, so they are not free to be tidied: renaming
 * one orphans every document written before the rename.
 *
 * Touchpoints: utils/s3OutputKey.js (buildOutputKey) and the five modules
 * listed on GENERATED_DOCUMENT_PUBLIC_READ, each of which names the type it
 * writes.
 */
export const OUTPUT_TYPE = {
  NDIS_INVOICE: 'NDIS-invoices',
  NDIS_QUOTE: 'NDIS-quote',
  PARTICIPANT_INVOICE: 'Participant-invoices',
  MONTHLY_STATEMENT: 'monthly-statements',
  STATEMENT_OF_ACCOUNT: 'statements-of-account',
  INVOICE: 'invoices',
  QUOTE: 'quote',
  PURCHASE_ORDER: 'purchaseorder',
};

/**
 * How long a link to a generated document stays valid.
 *
 * A non-public object is served by a presigned URL, which expires — unlike the
 * permanent public-bucket URL these replaced. Seven days is the maximum AWS
 * SigV4 allows, and matches what the Invoice Generator download already used.
 * A link written back to an ISO+ board therefore stops working after a week;
 * making those permanent needs an authenticated route that redirects to a
 * fresh signature, which is a separate change.
 *
 * Touchpoints: the five modules listed on GENERATED_DOCUMENT_PUBLIC_READ.
 */
export const GENERATED_PDF_URL_EXPIRY_SECONDS = 604800;
