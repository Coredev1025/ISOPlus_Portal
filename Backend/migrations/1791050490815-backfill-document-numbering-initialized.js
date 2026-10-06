/**
 * KAN-292. Make every business's stored numbering complete, and store whether
 * its first numbers have been set.
 *
 * ## Why
 *
 * A business created before the later series existed (statementOfAccount, then
 * statement) has no counter for them, and none has the documentNumberingInitialized
 * flag. Mongoose fills a missing path with its schema default when it loads a
 * business and writes that default back on a later save() of that copy. So a
 * stale save (the quote generator and several webhooks read a business, change
 * one counter and save) could write `nextNumber: 1` over a first number the user
 * had just chosen, which re-issues numbers already used elsewhere. Storing every
 * counter removes the missing paths, and with them the write-back.
 *
 * ## What it does
 *
 * - Adds any missing prefix and counter for the five series, with the schema's
 *   defaults. A real value is never changed. A null, or a value that is not an
 *   object where one is expected, counts as missing and is replaced by the default
 *   (null already reads as the default everywhere).
 * - Sets `documentNumberingInitialized` where it is missing: true when any of
 *   the four user-set series (not statement) has a counter other than 1, which
 *   means documents were issued, false otherwise. An existing flag is kept.
 *
 * Idempotent. Run it deliberately; it is not run on boot. Run it BEFORE the
 * deploy that introduces the first-numbers screen: until it has run, a business
 * with a counter missing is refused when it tries to set its first numbers (see
 * uninitializedFilter in utils/documentNumberingInitial.js). It is safe to run
 * while the app is up and against the old code: it only fills in what is missing.
 *
 * Needs MongoDB 4.2 or later: it is an update with an aggregation pipeline. That
 * does not work on Amazon DocumentDB.
 *
 * Down removes the flag and nothing else. The backfilled counters equal what
 * Mongoose would have supplied as defaults, and cannot be told apart from
 * counters that were always there, so they stay. It removes EVERY flag, including
 * one a user set after the migration; a business that chose 1 for all four and
 * has issued nothing then looks unset again. Only run it together with rolling
 * back the code that reads the flag.
 */

const SERIES_DEFAULTS = {
  invoice: 'INV-',
  purchaseOrder: 'PO-',
  quote: 'QT-',
  statement: 'STM-',
  statementOfAccount: 'SOA-',
};

// The series the user sets; STM- is issued by monthly statement automation.
const USER_SET_SERIES = ['invoice', 'purchaseOrder', 'quote', 'statementOfAccount'];

const counterOr1 = (series) => ({ $ifNull: [`$documentNumbering.${series}.nextNumber`, 1] });

const missingNumbering = () => Object.fromEntries(
  Object.entries(SERIES_DEFAULTS).flatMap(([series, prefix]) => [
    [`documentNumbering.${series}.prefix`, { $ifNull: [`$documentNumbering.${series}.prefix`, prefix] }],
    [`documentNumbering.${series}.nextNumber`, counterOr1(series)],
  ]),
);

/**
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  const anyCounterMoved = {
    $or: USER_SET_SERIES.map((series) => ({ $ne: [counterOr1(series), 1] })),
  };

  await connection.collection('businesses').updateMany({}, [
    // Decide from the counters as they were, before the defaults below are filled in.
    { $set: { documentNumberingInitialized: { $ifNull: ['$documentNumberingInitialized', anyCounterMoved] } } },
    { $set: missingNumbering() },
  ]);
}

/**
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  await connection.collection('businesses').updateMany(
    {},
    { $unset: { documentNumberingInitialized: '' } },
  );
}
