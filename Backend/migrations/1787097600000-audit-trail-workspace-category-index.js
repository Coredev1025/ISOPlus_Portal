/**
 * Compound index for workspace + category audit lists sorted by newest first.
 * Replaces collection scans from GET /api/audittrail (Xero logs dialog).
 *
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  await connection.collection('audittrails').createIndex(
    { workspaceId: 1, category: 1, createdAt: -1 },
    { name: 'workspaceId_1_category_1_createdAt_-1' }
  );
}

/**
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  try {
    await connection.collection('audittrails').dropIndex(
      'workspaceId_1_category_1_createdAt_-1'
    );
  } catch (err) {
    if (err?.code !== 27 && err?.codeName !== 'IndexNotFound') throw err;
  }
}
