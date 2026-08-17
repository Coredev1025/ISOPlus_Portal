/**
 * Optional PDFLink fields for scheduled automation runs, plus the index the
 * per-slot lookups need.
 *
 * The fields themselves (`boardId`, `participant`, `periodKey`, `invoiceNumber`,
 * `xeroInvoiceId`, `xeroInvoiceNumber`) need no backfill: they are optional,
 * new writes from generateDocuments / generateStatements /
 * pushDraftInvoicesToXero populate them, and existing URL-only rows stay as they
 * are. What does need creating is the index, because PDFLink declared none — so
 * every automation job full-scanned every PDF the workspace has ever generated.
 *
 * Key order is `workspaceId, periodKey, type, boardId` rather than putting
 * boardId third, so that one index serves both automation slot lookups. All four
 * predicates are equality, so Mongo needs only a prefix match:
 *   - generateDocuments' existingSlotResults queries all four — full match.
 *   - generateStatements' existingStatementLinks queries the first three
 *     (statements carry no boardId; they fold it into a synthetic itemId) —
 *     a prefix match.
 * Not covered: pushDraftInvoicesToXero's {workspaceId, itemId, periodKey}
 * lookup, which still scans within the workspace. That wants its own index and
 * its own ticket.
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

  // Scoped to rows an automation run wrote. `periodKey` is what distinguishes
  // them: the UI generators and the webhook PDF path also set `invoiceNumber`,
  // so an unbounded updateMany({}) would strip numbers this migration never
  // added.
  //
  // WARNING: unsetting `xeroInvoiceId` removes the guard in
  // pushDraftInvoicesToXero that makes the Xero push idempotent — it returns
  // early when the link already carries an id. After this rollback, a later run
  // over the same period will create a second draft invoice in Xero for every
  // invoice already pushed. Reconcile Xero before re-running the automation.
  //
  // `boardId` and `participant` are deliberately left in place: once the index
  // above is dropped they are inert metadata, and clearing them would cost a
  // second full-collection write for no benefit.
  await collection.updateMany(
    { periodKey: { $exists: true } },
    { $unset: {
      periodKey: '',
      invoiceNumber: '',
      xeroInvoiceId: '',
      xeroInvoiceNumber: '',
    } },
  );
}
