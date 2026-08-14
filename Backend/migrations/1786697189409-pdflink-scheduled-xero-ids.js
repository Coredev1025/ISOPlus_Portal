/**
 * Optional PDFLink fields for scheduled Xero invoice sync lookups.
 *
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  // Optional fields. New writes from generateDocuments / pushDraftInvoicesToXero
  // populate them. Existing URL-only rows stay as they are; lookup falls back
  // to the pdfLink regex until periodKey is present.
}

/**
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  await connection.collection('pdflinks').updateMany(
    {},
    { $unset: {
      periodKey: '',
      invoiceNumber: '',
      xeroInvoiceId: '',
      xeroInvoiceNumber: '',
    } },
  );
}
