#!/usr/bin/env node
//
// Ensure a local support-admin account with a known password.
//
//   npm run dev:user                        set the default password
//   npm run dev:user -- --list              show local users, change nothing
//   npm run dev:user -- --email a@b.com     target a specific user
//   npm run dev:user -- --password hunter2  choose the password
//   npm run dev:user -- --create            create the user if none exists
//
// Why this exists: the login page's primary button starts the ISO+ OAuth flow
// against app.isoplus.online, which cannot complete locally because the ISO+
// credentials are blank. Support agents sign in with Google (Workspace group
// membership enforced on the backend). This script only ensures a Mongo user
// row exists for local tooling — it does not grant a session.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULT_PASSWORD = 'local-dev-only'
const REQUIRED_ROLE = 'support_admin'

// --- arguments ---------------------------------------------------------------

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--email', '--password'])
const flags = {}
for (let i = 0; i < argv.length; i += 1) {
  if (VALUE_FLAGS.has(argv[i])) {
    flags[argv[i]] = argv[i + 1]
    i += 1
  } else if (argv[i].startsWith('-')) {
    flags[argv[i]] = true
  }
}

const mask = (uri) => uri.replace(/\/\/[^@/]*@/, '//***@')

// --- environment -------------------------------------------------------------

if (!process.env.MONGODB_URI) {
  const envFile = join(backendRoot, '.env')
  if (existsSync(envFile)) {
    const { config } = await import('dotenv')
    config({ path: envFile })
  }
}

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('error: MONGODB_URI is not set. From the repo root: npm run dev:user')
  process.exit(1)
}

// Local only, and deliberately with NO override flag.
//
// scripts/migrate.mjs offers --allow-remote because running a reviewed
// migration against a real database is sometimes legitimate. Setting a known,
// publicly-documented password never is: it is an immediate account compromise
// rather than a risky change. So there is no way to say "yes I'm sure" here.
if (!/(?:@|\/\/)(?:localhost|127\.0\.0\.1|mongo)[:/]/.test(uri)) {
  console.error(`error: refusing to run — MONGODB_URI is not local: ${mask(uri)}`)
  console.error('  This sets a known password, so it is restricted to local databases.')
  console.error('  There is no override flag. Point MONGODB_URI at your local Mongo.')
  process.exit(1)
}

// --- connect -----------------------------------------------------------------

const mongoose = (await import('mongoose')).default
await mongoose.connect(uri)

const { default: User } = await import(
  pathToFileURL(join(backendRoot, 'src', 'models', 'User.js')).href
)

const done = async (code) => {
  await mongoose.disconnect()
  process.exit(code)
}

const describe = (u) =>
  `${u.email}  role=${u.role}${u.disabled ? '  DISABLED' : ''}${u.password ? '' : '  (no password set)'}`

// --- list --------------------------------------------------------------------

if (flags['--list']) {
  const users = await User.find({}, 'email role disabled password').lean()
  console.log(`\n${users.length} user(s) in ${mongoose.connection.db.databaseName}:\n`)
  for (const u of users) console.log(`  ${describe(u)}`)
  console.log('')
  await done(0)
}

// --- find the target ---------------------------------------------------------

const password = typeof flags['--password'] === 'string' ? flags['--password'] : DEFAULT_PASSWORD
const email = typeof flags['--email'] === 'string' ? flags['--email'] : undefined

let user
if (email) {
  user = await User.findOne({ email })
} else {
  const admins = await User.find({ role: REQUIRED_ROLE })
  if (admins.length > 1) {
    console.error(`error: ${admins.length} ${REQUIRED_ROLE} users exist — choose one with --email:`)
    for (const a of admins) console.error(`  ${a.email}`)
    await done(1)
  }
  user = admins[0]
}

if (!user && !flags['--create']) {
  // `password` must be selected or describe() reports "(no password set)" for
  // every user, including ones that have one.
  const all = await User.find({}, 'email role disabled password').lean()
  console.error(`error: no ${email ? `user "${email}"` : `${REQUIRED_ROLE} user`} found.`)
  if (all.length) {
    console.error('  Existing users:')
    for (const u of all) console.error(`    ${describe(u)}`)
  } else {
    console.error('  The users collection is empty — has the database been seeded? (npm run seed)')
  }
  console.error(`  Re-run with --create${email ? '' : ' --email you@example.com'} to create one.`)
  await done(1)
}

// --- create or update --------------------------------------------------------

const corrections = []

if (!user) {
  user = new User({
    email: email ?? 'dev@local',
    name: 'Local Developer',
    role: REQUIRED_ROLE,
    disabled: false,
  })
  corrections.push('created')
} else {
  // POST /api/auth/login admits support_admin only, and rejects disabled
  // accounts — correct both rather than leaving a login that mysteriously fails.
  if (user.role !== REQUIRED_ROLE) {
    corrections.push(`role ${user.role} -> ${REQUIRED_ROLE}`)
    user.role = REQUIRED_ROLE
  }
  if (user.disabled) {
    corrections.push('re-enabled (was disabled)')
    user.disabled = false
  }
}

// Assign the plaintext and save: User.js hashes on pre('save') with bcrypt cost
// 10, which is what comparePassword checks against. Writing the collection
// directly would store plaintext that /api/auth/login could never match.
user.password = password
await user.save()

console.log('')
console.log(`  database  ${mongoose.connection.db.databaseName}`)
console.log(`  email     ${user.email}`)
console.log(`  password  ${password}`)
console.log(`  role      ${user.role}`)
if (corrections.length) console.log(`  changed   ${corrections.join(', ')}`)
console.log('')
console.log('  Sign in at the frontend: choose "administrator credentials" on the')
console.log('  login screen rather than the ISO+ button, which needs the live service.')
console.log('')
console.log('  Re-running npm run seed replaces the users collection and clears this.')
console.log('')

await done(0)
