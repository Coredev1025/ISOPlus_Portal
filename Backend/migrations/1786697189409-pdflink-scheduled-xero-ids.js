/**
 * Optional PDFLink fields for scheduled automation runs, plus the index the
 * per-slot lookups need. The fields need no backfill; the index does, because
 * PDFLink declared none.
 *
 * Key order is `workspaceId, periodKey, type, boardId` rather than putting
 * boardId third, so that one index serves both automation slot lookups. All
 * four predicates are equality, so Mongo needs only a prefix match:
 *   - generateDocuments' existingSlotResults queries all four — full match.
 *   - generateStatements' existingStatementLinks queries the first three
 *     (statements carry no boardId; they fold it into a synthetic itemId) —
 *     a prefix match.
 */

const INDEX_NAME = 'automation_slot_lookup';

const INDEX_KEYS = {
  workspaceId: 1,
  periodKey: 1,
  type: 1,
  boardId: 1,
};

/**
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  await connection.collection('pdflinks').createIndex(INDEX_KEYS, {
    name: INDEX_NAME,
    background: true,
  });
}

/**
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  const collection = connection.collection('pdflinks');

  await collection.dropIndex(INDEX_NAME);

  // Scoped to rows an automation run wrote: `periodKey` is what distinguishes
  // them, so an unbounded updateMany({}) would strip the `invoiceNumber` the UI
  // generators and the webhook PDF path set. `boardId` and `participant` are
  // left in place — inert metadata once the index is dropped.
  await collection.updateMany(
    { periodKey: { $exists: true } },
    { $unset: {
      periodKey: '',
      invoiceNumber: '',
    } },
  );
}
