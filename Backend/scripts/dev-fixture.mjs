#!/usr/bin/env node
//
// Load the NDIS quote fixture into the local database.
//
//   npm run dev:fixture                     upsert Business, Board and Items
//   npm run dev:fixture -- --list           show what is already there, change nothing
//   npm run dev:fixture -- --remove         delete only the documents this script wrote
//   npm run dev:fixture -- --file <path>    use a different fixture
//   npm run dev:fixture -- --replay <name>  POST a recorded webhook body at the local API
//   npm run dev:fixture -- --replay <name> --dry-run   print the request, send nothing
//
// Why this exists: the Mongo dump in seed/ is real customer data, is gitignored,
// and whatever board it happens to contain is not a stable thing to write code
// against. This gives a small, committed, invented scenario instead — the NDIS
// quote board, with items that exercise both pricing paths.
//
// The pricing split is the reason for the odd-looking item data. Dispatch runs
// resolveNdisPricingRuleForAutomation(), which consults, in order:
//
//   1. the webhook `values` keys,
//   2. the stored Item.data keys,
//   3. the board's attribute list — fetched from the LIVE ISO+ API.
//
// Step 3 cannot work offline: getBoardAttributes() fails, boardUsesLegacyNdisPricing()
// swallows that and returns true, and every item resolves to 'legacy' — the
// opposite of what the live board does. So the fixture items carry the sentinel
// keys ('Support Item Number' / 'Direct Support Item Number') and decide at step
// 1 or 2, before anything touches the network.
//
// This adds NO application code. It writes documents through the app's own models.
//
// A fixture may declare a single `board` (the original shape) or a `boards`
// array; with multiple boards every item must name its `boardId`. Optional
// `automationSettings` (one doc per workspace) and `scheduledJobs` (keyed on
// {kind, targetId}) sections seed the KAN-10 automation rows; an optional
// `invoiceNumbers` section (keyed on {itemId, workspaceId, boardId, type})
// seeds already-invoiced rows. Shape rules are pure and unit-tested in
// devFixtureShape.mjs.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { normalizeFixture, stripDollarKeys } from './devFixtureShape.mjs'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_FIXTURE = join(backendRoot, 'test', 'fixtures', 'ndis-quote-board.json')

// --- arguments ---------------------------------------------------------------

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--file', '--replay', '--base-url'])
const flags = {}
for (let i = 0; i < argv.length; i += 1) {
  if (VALUE_FLAGS.has(argv[i])) {
    flags[argv[i]] = argv[i + 1]
    i += 1
  } else if (argv[i].startsWith('-')) {
    flags[argv[i]] = true
  } else {
    console.error(`error: unexpected argument "${argv[i]}"`)
    process.exit(1)
  }
}

const mask = (uri) => uri.replace(/\/\/[^@/]*@/, '//***@')

// --- fixture -----------------------------------------------------------------

const fixturePath = typeof flags['--file'] === 'string'
  ? resolve(process.cwd(), flags['--file'])
  : DEFAULT_FIXTURE

if (!existsSync(fixturePath)) {
  console.error(`error: no fixture at ${fixturePath}`)
  process.exit(1)
}

let fixture
try {
  fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
} catch (err) {
  console.error(`error: ${fixturePath} is not valid JSON — ${err.message}`)
  process.exit(1)
}

// Shape rules (single `board` vs `boards`, per-item boardId, automation
// sections, date coercion) live in devFixtureShape.mjs so they are unit-tested.
const { webhookPayloads = {} } = fixture
let shape
try {
  shape = normalizeFixture(fixture)
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
}
const { workspaceId, business, boards, items, automationSettings, scheduledJobs, invoiceNumbers } = shape

// --- replay ------------------------------------------------------------------
//
// Kept before the Mongo connection: replaying is an HTTP concern and should not
// require a reachable database.

if (typeof flags['--replay'] === 'string') {
  const name = flags['--replay']
  const payload = webhookPayloads[name]
  if (!payload) {
    console.error(`error: no webhook payload named "${name}" in the fixture.`)
    console.error(`  available: ${Object.keys(webhookPayloads).join(', ') || '(none)'}`)
    process.exit(1)
  }

  // $url in the fixture is the production path; the host comes from the caller.
  const path = String(payload.$url || '').replace(/^[A-Z]+\s+/, '')
  if (!path.startsWith('/')) {
    console.error(`error: payload "${name}" has no usable $url`)
    process.exit(1)
  }

  const baseUrl = typeof flags['--base-url'] === 'string'
    ? flags['--base-url'].replace(/\/$/, '')
    : (process.env.FIXTURE_BASE_URL || 'http://localhost:4001')

  // Strip the $-prefixed annotations; they document the payload, they are not part of it.
  const body = Object.fromEntries(Object.entries(payload).filter(([k]) => !k.startsWith('$')))
  const target = `${baseUrl}${path}`

  console.log(`\n  POST ${target}`)
  if (payload.$automation) console.log(`  fires from: ${payload.$automation}`)
  if (payload.$expect) console.log(`  expected:   ${payload.$expect}`)
  console.log(`\n${JSON.stringify(body, null, 2)}\n`)

  if (flags['--dry-run']) {
    console.log('  --dry-run: nothing sent\n')
    process.exit(0)
  }

  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    console.log(`  → HTTP ${res.status}`)
    console.log(`  → ${text.slice(0, 2000)}\n`)
    // These routes answer 200 even when they reject the request, so the body is
    // the only thing that tells you what happened. Say so rather than implying
    // 200 means success.
    if (res.status === 200 && /error|Invalid|not found|required/i.test(text)) {
      console.log('  note: HTTP 200 with an error body — this family reports failures in the body.\n')
    }
  } catch (err) {
    console.error(`error: request to ${target} failed — ${err.message}`)
    console.error('  is the stack up? npm run dev:up')
    process.exit(1)
  }
  process.exit(0)
}

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
  console.error('error: MONGODB_URI is not set. From the repo root: npm run dev:fixture')
  process.exit(1)
}

// Local only, and deliberately with no override flag, for the same reason
// dev-user.mjs has none: this writes invented business and participant records.
// Landing those in a real database would be a data-integrity incident, not a
// risky-but-sometimes-justified change.
if (!/(?:@|\/\/)(?:localhost|127\.0\.0\.1|mongo)[:/]/.test(uri)) {
  console.error(`error: refusing to run — MONGODB_URI is not local: ${mask(uri)}`)
  console.error('  This writes invented fixture data, so it is restricted to local databases.')
  console.error('  There is no override flag. Point MONGODB_URI at your local Mongo.')
  process.exit(1)
}

// --- connect -----------------------------------------------------------------

const mongoose = (await import('mongoose')).default
await mongoose.connect(uri)

const model = async (name) => (await import(
  pathToFileURL(join(backendRoot, 'src', 'models', `${name}.js`)).href
)).default

const Business = await model('Business')
const Board = await model('Board')
const Item = await model('Item')
const AutomationSettings = await model('AutomationSettings')
const ScheduledJob = await model('ScheduledJob')
const InvoiceNumber = await model('InvoiceNumber')

const done = async (code) => {
  await mongoose.disconnect()
  process.exit(code)
}

const itemIds = items.map((i) => i.itemId)
const boardIds = boards.map((b) => b.boardId)
// The exact upsert/delete keys for the fixture's ScheduledJob rows — the
// {kind, targetId} pair carries the collection's unique index.
const jobKeys = scheduledJobs.map((j) => ({ kind: j.kind, targetId: j.targetId }))
// InvoiceNumber rows are removed by {itemId, type}, always scoped to the
// fixture's workspaceId — a seeded database can hold real invoice numbers.
const invoiceKeys = invoiceNumbers.map((n) => ({ itemId: n.itemId, type: n.type }))
const dbName = mongoose.connection.db.databaseName

const pricingRule = (keys) => (keys.includes('Support Item Number') ? 'new'
  : keys.includes('Direct Support Item Number') ? 'legacy'
    : null)

// --- list --------------------------------------------------------------------

const listBoardItems = (boardItems, found) => {
  for (const i of boardItems) {
    const hit = found.find((f) => f.itemId === i.itemId)
    console.log(`    ${hit ? '✓' : '✗'} ${i.itemId}`)
    if (!hit) continue
    const rule = pricingRule(Object.keys(hit.data || {}))
      ?? 'falls through to the board rule (needs live ISO+)'
    console.log(`        pricing rule: ${rule}`)
  }
}

const listAutomationSections = async () => {
  if (automationSettings) {
    const doc = await AutomationSettings.findOne({ workspaceId }).lean()
    console.log(`  automationSettings       ${doc ? 'present' : 'MISSING'}`)
  }
  if (jobKeys.length === 0) return
  const foundJobs = await ScheduledJob.find({ $or: jobKeys }, 'kind targetId nextRunAt enabled').lean()
  console.log(`  scheduledJobs            ${foundJobs.length}/${jobKeys.length} present`)
  for (const key of jobKeys) {
    const hit = foundJobs.find((f) => f.kind === key.kind && f.targetId === key.targetId)
    const detail = hit ? `  next ${hit.nextRunAt?.toISOString() ?? '(unset)'}${hit.enabled ? '' : '  DISABLED'}` : ''
    console.log(`    ${hit ? '✓' : '✗'} ${key.kind} → ${key.targetId}${detail}`)
  }
}

const listInvoiceNumbers = async () => {
  if (invoiceKeys.length === 0) return
  const found = await InvoiceNumber.find(
    { workspaceId, $or: invoiceKeys }, 'itemId type invoiceNumber',
  ).lean()
  console.log(`  invoiceNumbers           ${found.length}/${invoiceKeys.length} present`)
  for (const n of invoiceNumbers) {
    const hit = found.find((f) => f.itemId === n.itemId && f.type === n.type)
    console.log(`    ${hit ? '✓' : '✗'} ${n.itemId} [${n.type}] ${n.invoiceNumber}`)
  }
}

if (flags['--list']) {
  const [biz, foundBoards, found] = await Promise.all([
    Business.findOne({ workspaceId }).lean(),
    Board.find({ workspaceId, boardId: { $in: boardIds } }).lean(),
    Item.find({ workspaceId, itemId: { $in: itemIds } }, 'itemId folderId data').lean(),
  ])

  console.log(`\nfixture "${fixturePath}" against "${dbName}":\n`)
  console.log(`  business ${workspaceId}  ${biz ? `present — ${biz.name}` : 'MISSING'}`)
  for (const b of boards) {
    const brd = foundBoards.find((f) => f.boardId === b.boardId)
    const boardItems = items.filter((i) => i.boardId === b.boardId)
    const present = boardItems.filter((i) => found.some((f) => f.itemId === i.itemId))
    console.log(`  board ${b.boardId}   ${brd ? `present — ${brd.name}` : 'MISSING'}`)
    console.log(`  items                    ${present.length}/${boardItems.length} present`)
    listBoardItems(boardItems, found)
  }
  await listAutomationSections()
  await listInvoiceNumbers()
  console.log('')
  await done(0)
}

// --- remove ------------------------------------------------------------------
//
// Scoped to the exact ids the fixture defines. A seeded database holds real
// boards under the same workspace, so anything broader than this would take
// them with it.

if (flags['--remove']) {
  const removedItems = await Item.deleteMany({ workspaceId, itemId: { $in: itemIds } })
  const removedBoards = await Board.deleteMany({ workspaceId, boardId: { $in: boardIds } })
  const removedBiz = business
    ? await Business.deleteMany({ workspaceId, name: business.name })
    : { deletedCount: 0 }

  console.log(`\nremoved from "${dbName}":`)
  console.log(`  items     ${removedItems.deletedCount}`)
  console.log(`  boards    ${removedBoards.deletedCount}`)
  console.log(`  business  ${removedBiz.deletedCount}  (matched on the fixture's name only)`)
  // Automation rows go only when the fixture declares them — never by
  // workspace alone, since a seeded database can hold real settings and jobs
  // under the same workspace.
  if (automationSettings) {
    const removed = await AutomationSettings.deleteMany({ workspaceId })
    console.log(`  automationSettings  ${removed.deletedCount}`)
  }
  if (jobKeys.length > 0) {
    const removed = await ScheduledJob.deleteMany({ $or: jobKeys })
    console.log(`  scheduledJobs       ${removed.deletedCount}  (matched on the fixture's kind/targetId pairs only)`)
  }
  if (invoiceKeys.length > 0) {
    const removed = await InvoiceNumber.deleteMany({ workspaceId, $or: invoiceKeys })
    console.log(`  invoiceNumbers      ${removed.deletedCount}  (matched on the fixture's itemId/type pairs only)`)
  }
  console.log('')
  await done(0)
}

// --- load --------------------------------------------------------------------

console.log(`\nloading ${fixturePath}`)
console.log(`  into "${dbName}"\n`)

if (business) {
  const existingBiz = await Business.findOne({ workspaceId }).lean()
  if (existingBiz && existingBiz.name !== business.name) {
    // The seed dump defines a real Business for this workspace. Overwriting it
    // would change document numbering and company details under the operator's
    // feet, and they would find out via a wrong PDF.
    console.error(`error: workspace ${workspaceId} already has a different business: "${existingBiz.name}"`)
    console.error('  Refusing to overwrite it. Either:')
    console.error('    - drop it first, if it is disposable, or')
    console.error('    - change business.workspaceId in the fixture to an unused workspace.')
    await done(1)
  }

  await Business.findOneAndUpdate(
    { workspaceId },
    { $set: stripDollarKeys(business) },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  console.log(`  business  ${workspaceId} — ${business.name}`)
}

for (const b of boards) {
  await Board.findOneAndUpdate(
    { workspaceId, boardId: b.boardId },
    { $set: stripDollarKeys(b) },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  console.log(`  board     ${b.boardId} — ${b.name}`)
}

for (const item of items) {
  const { itemId, boardId, folderId, data } = item
  await Item.findOneAndUpdate(
    { itemId },
    {
      $set: {
        workspaceId,
        boardId,
        folderId,
        itemId,
        isoPlusItemId: itemId,
        data,
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  const rule = pricingRule(Object.keys(data || {})) ?? 'board rule'
  console.log(`  item      ${itemId}  [${rule}]`)
}

if (automationSettings) {
  await AutomationSettings.findOneAndUpdate(
    { workspaceId },
    { $set: stripDollarKeys(automationSettings) },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  console.log(`  automationSettings  workspace ${workspaceId}`)
}

for (const job of scheduledJobs) {
  // Keyed on the collection's unique {kind, targetId} index. findOneAndUpdate
  // skips document middleware, so the schema's cron/schedule XOR hook does not
  // run here — the fixture rows carry `schedule` with `cron: null`, matching
  // what upsertSchedule writes in production.
  await ScheduledJob.findOneAndUpdate(
    { kind: job.kind, targetId: job.targetId },
    { $set: stripDollarKeys(job) },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  console.log(`  scheduledJob        ${job.kind} → ${job.targetId}`)
}

for (const n of invoiceNumbers) {
  // Keyed the way the UI reads these rows: one row per item/type within a
  // workspace+board. findOneAndUpdate skips the schema's pre('save') hook, so
  // updatedAt keeps whatever the fixture (or the insert default) set.
  await InvoiceNumber.findOneAndUpdate(
    { itemId: n.itemId, workspaceId: n.workspaceId, boardId: n.boardId, type: n.type },
    { $set: stripDollarKeys(n) },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  console.log(`  invoiceNumber       ${n.itemId} [${n.type}] ${n.invoiceNumber}`)
}

console.log(`\n  ${items.length} item(s) loaded. Inspect with: npm run dev:fixture -- --list`)
console.log(`  Replay a webhook:            npm run dev:fixture -- --replay quotendis --dry-run\n`)

await done(0)
