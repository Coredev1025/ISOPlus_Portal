/**
 * The indexes of the new `invoices` collection (KAN-302).
 *
 * The collection itself needs no migration: Mongo creates it with the first
 * document, and the new fields on `items` (`activeInvoiceId`) and `pdflinks`
 * (`invoiceId`) are optional and absent on every existing row, which is how
 * "not yet linked" reads.
 *
 * ## The unique index
 *
 * `invoice_number_unique` is on (workspaceId, source, number, duplicateOrdinal).
 * It is what makes committing an invoice idempotent: a retry after a crash cannot
 * create a second invoice for the same number. `duplicateOrdinal` is 0 for the
 * invoice that owns a number, and 1, 2, ... for a backfilled invoice that shares
 * a number with a different real one (production can hold those: the document
 * number allocator once had a read-then-increment race, and a user could set
 * `nextNumber` before KAN-290). It is not a partial index because a partial
 * filter cannot test for an absent field.
 *
 * ## The others
 *
 * Lookups the readers need: by item (a multikey index on the lines), by a
 * legacy number string, by participant on a board, and by slot for replay.
 *
 * Nothing is built on existing data, so this is safe to run at any time and does
 * not need the application stopped.
 *

 * It also builds `invoice_document` on `pdflinks.invoiceId` (partial: only rows that
 * carry one), the reverse lookup `stampXero` and the audit use. A small build on a
 * collection whose rows have no such field yet.
 *
 * Down drops the indexes and keeps every invoice: the documents are billing
 * records, and a rollback of an index must not delete them.
 */

const DOCUMENT_INDEX = {
  name: 'invoice_document',
  key: { invoiceId: 1 },
  // Only rows that carry an invoice id: the field is absent on every existing row.
  options: { partialFilterExpression: { invoiceId: { $exists: true } } },
};

const INDEXES = [
  {
    name: 'invoice_number_unique',
    key: { workspaceId: 1, source: 1, number: 1, duplicateOrdinal: 1 },
    options: { unique: true },
  },
  {
    name: 'invoice_line_item',
    key: { workspaceId: 1, 'lines.itemId': 1 },
  },
  {
    name: 'invoice_legacy_number',
    key: { workspaceId: 1, legacyNumbers: 1 },
  },
  {
    name: 'invoice_participant',
    key: { workspaceId: 1, boardId: 1, 'participant.name': 1, issuedAt: -1 },
  },
  {
    name: 'invoice_slot',
    key: { workspaceId: 1, boardId: 1, periodKey: 1 },
  },
];

/**
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  const collection = connection.collection('invoices');
  // createIndex is idempotent for an identical definition, so a second run is a no-op.
  for (const { name, key, options = {} } of INDEXES) {
    await collection.createIndex(key, { name, background: true, ...options });
  }
  // The reverse lookup from a document row to its invoice (stampXero, the audit).
  const { name, key, options } = DOCUMENT_INDEX;
  await connection.collection('pdflinks').createIndex(key, { name, background: true, ...options });
}

// Dropping something that is not there is the normal state on a second run or a
// fresh database; any other error is real and must surface.
const IGNORABLE = new Set(['IndexNotFound', 'NamespaceNotFound']);
const dropQuietly = (collection, name) => collection.dropIndex(name).catch((err) => {
  if (!IGNORABLE.has(err?.codeName)) throw err;
});

/**
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  const collection = connection.collection('invoices');
  for (const { name } of INDEXES) {
    await dropQuietly(collection, name);
  }
  await dropQuietly(connection.collection('pdflinks'), DOCUMENT_INDEX.name);
}
