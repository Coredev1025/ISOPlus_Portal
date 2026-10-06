// mongosh script: scrub a restored copy of production BEFORE anything connects to it.
// Run by `npm run rehearse` (docs/release-runbook.md, "Rehearsing on a copy of production", step 2):
//   mongosh --quiet <database> --file scripts/rehearse/scrub.js
// Offline mode does not cover Xero, so the protection is that no token exists. Prints
// {"before":{...},"after":{...}}; every "after" number must be 0 or the rehearsal stops.
// Anything this script does not touch is NOT scrubbed: add to it, do not work around it.
// Email addresses in audit trails, subscriptions and businesses are personal data, not credentials:
// they stay, so treat the whole copy as sensitive and delete it when the rehearsal is signed off.

const count = (name, filter) => (db.getCollectionNames().includes(name) ? db.getCollection(name).countDocuments(filter || {}) : 0)

const checks = {
  'businesses with Xero tokens': () => count('businesses', { xeroTokens: { $exists: true } }),
  'sessions': () => count('sessions'),
  'oauth tickets (they hold an email and a name too)': () => count('oauthtickets'),
  'xero connect tickets': () => count('xeroconnecttickets'),
  'enabled scheduled jobs': () => count('scheduledjobs', { enabled: true }),
  'enabled automation blocks': () => count('automationsettings', { $or: [{ 'invoice.enabled': true }, { 'statement.enabled': true }] }),
  'boards with a hook secret': () => count('boards', { hookSecret: { $exists: true } }),
  'users': () => count('users'),
  // Any document, in any collection, still holding a token or a password under a top-level key.
  'other documents with a token or password': () => db.getCollectionNames().reduce((n, name) => n + db.getCollection(name).countDocuments({
    $or: [{ accessToken: { $nin: [null, ''] } }, { refreshToken: { $nin: [null, ''] } }, { hookSecret: { $exists: true } }, { password: { $exists: true } }],
  }), 0),
}

const snapshot = () => Object.fromEntries(Object.entries(checks).map(([name, fn]) => [name, fn()]))
const before = snapshot()

const has = (name) => db.getCollectionNames().includes(name)
if (has('businesses')) db.businesses.updateMany({}, { $unset: { xeroTokens: '' } })
if (has('sessions')) db.sessions.deleteMany({})
if (has('oauthtickets')) db.oauthtickets.deleteMany({})
if (has('xeroconnecttickets')) db.xeroconnecttickets.deleteMany({})
if (has('scheduledjobs')) db.scheduledjobs.updateMany({}, { $set: { enabled: false } })
if (has('automationsettings')) db.automationsettings.updateMany({}, { $set: { 'invoice.enabled': false, 'statement.enabled': false } })
if (has('boards')) db.boards.updateMany({}, { $unset: { hookSecret: '' } })
if (has('users')) db.users.deleteMany({})

print(JSON.stringify({ before, after: snapshot() }))
