/**
 * One-shot cleanup of EventBridge-era portal board_sync ScheduledJob rows.
 * Those rows must stay disabled — a tick would claim them with no registered
 * handler after catch-up moved to the in-process clock.
 *
 * Lives here rather than boot: boot already surfaces Mongo failures, and a
 * retry loop at startup was pure noise.
 */

/**
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  await connection.collection('scheduledjobs').updateMany(
    { kind: 'board_sync', targetId: 'portal', enabled: true },
    { $set: { enabled: false } },
  );
}

/**
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  await connection.collection('scheduledjobs').updateMany(
    { kind: 'board_sync', targetId: 'portal', enabled: false },
    { $set: { enabled: true } },
  );
}
