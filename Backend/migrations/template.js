// Template used by `npm run migrate create <name>`.
//
// Migrations are plain ESM JavaScript, matching the rest of Backend/
// ("type": "module"). Both functions receive the live Mongoose connection, so
// you can use the driver directly or import a model from ../src/models.

/**
 * Apply the change.
 *
 * @param {import('mongoose').Connection} connection
 */
export async function up(connection) {
  // Example — add a field with a default to every existing document:
  //
  //   await connection.collection('items').updateMany(
  //     { archived: { $exists: false } },
  //     { $set: { archived: false } },
  //   )
}

/**
 * Undo the change. Make this a genuine inverse of `up` — a migration you
 * cannot roll back is one you cannot safely deploy.
 *
 * @param {import('mongoose').Connection} connection
 */
export async function down(connection) {
  //   await connection.collection('items').updateMany(
  //     {},
  //     { $unset: { archived: '' } },
  //   )
}
