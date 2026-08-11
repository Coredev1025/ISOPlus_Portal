// KAN-15 — create the ScheduledJob indexes as a deliberate, deployed step.
//
// The two indexes are also declared on the schema (src/models/ScheduledJob.js),
// and Mongoose builds them on connect because `autoIndex` is left at its
// default of true. That is how every other model in this codebase gets its
// indexes, and it works — but it makes the unique constraint on
// { kind, targetId } a side effect of application boot rather than something
// anyone decided.
//
// That constraint is load-bearing: it is what stops a toggle flipped twice from
// creating two schedules for the same board, which would double-dispatch. If
// `autoIndex` is ever disabled for performance — a common production tuning —
// the constraint silently stops being created on fresh environments and the
// duplicate becomes possible with nothing to catch it.
//
// This migration is idempotent. `createIndex` is a no-op when an index with the
// same keys, options and name already exists, so running it against an
// environment where autoIndex already did the work changes nothing.

const COLLECTION = 'scheduledjobs';

const DUE_QUERY_INDEX = {
  keys: { enabled: 1, nextRunAt: 1 },
  options: { name: 'enabled_1_nextRunAt_1' },
};

const UNIQUE_TARGET_INDEX = {
  keys: { kind: 1, targetId: 1 },
  options: { name: 'kind_1_targetId_1', unique: true },
};

/**
 * Apply the change.
 *
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  const collection = connection.collection(COLLECTION);

  // The only query the tick makes: enabled schedules whose nextRunAt has passed.
  await collection.createIndex(DUE_QUERY_INDEX.keys, DUE_QUERY_INDEX.options);

  // One schedule per kind per target. See the note above on why this matters.
  await collection.createIndex(
    UNIQUE_TARGET_INDEX.keys,
    UNIQUE_TARGET_INDEX.options,
  );
}

/**
 * Undo the change. Make this a genuine inverse of `up` — a migration you
 * cannot roll back is one you cannot safely deploy.
 *
 * Dropping is guarded: an index that is not there is not an error worth
 * failing a rollback over, and `dropIndex` throws IndexNotFound rather than
 * no-oping.
 *
 * Note that rolling this back does not durably remove the indexes while
 * `autoIndex` remains enabled — the next application boot recreates them from
 * the schema. That is the honest limit of this migration: it makes creation
 * deliberate, it cannot make it exclusive.
 *
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  const collection = connection.collection(COLLECTION);

  for (const index of [UNIQUE_TARGET_INDEX, DUE_QUERY_INDEX]) {
    try {
      await collection.dropIndex(index.options.name);
    } catch (err) {
      // IndexNotFound (27) — already absent, which is the state we wanted.
      if (err?.code !== 27) throw err;
    }
  }
}
