/**
 * The index the SES delivery-event lookup needs on `pdflinks`.
 *
 * `POST /api/email/events` matches an arriving Delivery/Bounce/Complaint back
 * to the documents its email carried by `deliveryMessageId`, and it does so on
 * a request path AWS will retry. Without an index that is a collection scan of
 * every PDF the product has ever generated, per event.
 *
 * Sparse, because the field is only present on rows an SES send has stamped —
 * every UI-generated and webhook-generated PDF has none, and those are the
 * majority. A sparse index skips them entirely, which is both smaller and
 * exactly the set the lookup queries.
 *
 * **No backfill, deliberately.** The three companion fields
 * (`deliveryMessageId`, `deliveryState`, `deliveryDetail`, `deliveryUpdatedAt`)
 * are all optional and all absent on existing rows. A Mongoose `default`
 * applies to new documents only, so those rows keep no `deliveryState` at all
 * — and that is correct: they were never emailed by this feature. The read
 * side handles it rather than a mass rewrite of the collection:
 * `loadRecentAutomationDocuments` projects
 * `{ $ifNull: ['$deliveryState', 'generated'] }`. Rewriting every pdflinks
 * document to set a value the reader already supplies would be a long,
 * lock-taking write for no behavioural difference.
 */

const INDEX_NAME = 'delivery_message_lookup';

/**
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  await connection.collection('pdflinks').createIndex(
    { deliveryMessageId: 1 },
    { name: INDEX_NAME, sparse: true, background: true },
  );
}

/**
 * @param {import('mongoose').Connection} connection
 *
 * A genuine inverse: drop the index, then remove the four fields this feature
 * introduced. The `$unset` is scoped to rows that actually carry
 * `deliveryMessageId` — the only rows any of this wrote — so an unbounded
 * `updateMany({})` cannot touch documents owned by the UI generators or the
 * webhook PDF path.
 */
export async function down(connection) {
  const collection = connection.collection('pdflinks');

  await collection.dropIndex(INDEX_NAME);

  await collection.updateMany(
    { deliveryMessageId: { $exists: true } },
    {
      $unset: {
        deliveryMessageId: '',
        deliveryState: '',
        deliveryDetail: '',
        deliveryUpdatedAt: '',
      },
    },
  );
}
