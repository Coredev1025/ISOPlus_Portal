/**
 * Drop historical Xero connection activity that was stored on businesses.
 * Those events now live in AuditTrail (category: Xero).
 *
 * This is not reversible: the log documents themselves are not copied out
 * before unset. `down` restores an empty array so the field exists again,
 * which is the closest inverse that does not invent history.
 *
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  await connection.collection('businesses').updateMany(
    { xeroConnectionLogs: { $exists: true } },
    { $unset: { xeroConnectionLogs: '' } },
  );
}

/**
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  await connection.collection('businesses').updateMany(
    { xeroConnectionLogs: { $exists: false } },
    { $set: { xeroConnectionLogs: [] } },
  );
}
