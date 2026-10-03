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
 *   defaults. Existing values are never changed.
 * - Sets `documentNumberingInitialized` where it is missing: true when any of
 *   the four user-set series (not statement) has a counter other than 1, which
 *   means documents were issued, false otherwise. An existing flag is kept.
 *
 * Idempotent. Run it deliberately after the deploy that introduces the flag; it
 * is not run on boot. It is safe to run while the app is up: it only fills in
 * what is missing.
 *
 * Down removes the flag and nothing else. The backfilled counters equal what
 * Mongoose would have supplied as defaults, and cannot be told apart from
 * counters that were always there, so they stay.
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
