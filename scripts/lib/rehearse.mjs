// Release rehearsal harness (docs/roadmap/release-rehearsal.md): restore a production dump into a
// throwaway MongoDB, scrub it, and replay the runbook's scripts in order, checking the result
// against committed expectations. Docker only; no dependencies. The logic that can be tested
// without Docker is in rehearse-parse.mjs.

import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acknowledgements, compareExpectations, draftExpectations, leakPatterns, parseBackfillDryRun, unexpectedKeys, parseMarkerDryRun,
  parsePendingMigrations, stripAnsi, summariseAudit, summariseStages,
} from './rehearse-parse.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND = join(REPO, 'Backend')
export const MONGO_CONTAINER = 'isoplus-rehearsal-mongo'
export const MONGO_IMAGE = 'mongo:8.0'
export const NETWORK = 'isoplus-rehearsal-net'
const BACKEND_IMAGE = 'isoplus-portal-backend'
const OLD_STORES = ['items', 'invoicenumbers', 'pdflinks', 'invoices', 'businesses', 'boards']

function docker(args, options = {}) {
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...options })
  if (res.error) throw res.error
  return { code: res.status ?? 1, out: (res.stdout || '') + (res.stderr || ''), stdout: res.stdout || '' }
}

const dockerOk = (args, options) => {
  const res = docker(args, options)
  if (res.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed:\n${res.out.slice(-800)}`)
  return res
}

/** Pipe a file into a docker command's stdin and wait. */
function pipeFile(file, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (d) => { log += d })
    child.stderr.on('data', (d) => { log += d })
    createReadStream(file).pipe(child.stdin)
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolvePromise(log) : reject(new Error(`docker ${args[0]} exited ${code}:\n${log.slice(-800)}`))))
  })
}

export function assertPrerequisites() {
  if (docker(['version', '--format', '{{.Server.Version}}']).code !== 0) throw new Error('Docker is not running.')
  if (docker(['image', 'inspect', BACKEND_IMAGE]).code !== 0) throw new Error(`The image ${BACKEND_IMAGE} is missing: run "npm run dev:build" once.`)
}

function waitForMongo(container) {
  for (let i = 0; i < 60; i += 1) {
    if (docker(['exec', container, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok']).out.trim().endsWith('1')) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  throw new Error(`MongoDB in ${container} did not start.`)
}

/**
 * A fresh throwaway MongoDB: no published port, and on an internal Docker network with no route out, so
 * neither it nor the Backend scripts that share its network can reach anything outside the machine.
 */
export function startMongo() {
  docker(['rm', '-fv', MONGO_CONTAINER])
  docker(['network', 'rm', NETWORK])
  dockerOk(['network', 'create', '--internal', NETWORK])
  dockerOk(['run', '-d', '--name', MONGO_CONTAINER, '--network', NETWORK, MONGO_IMAGE, '--wiredTigerCacheSizeGB', '1'])
  waitForMongo(MONGO_CONTAINER)
}

/** Remove the container WITH its volumes (they hold the dump as restored, before the scrub) and the network. */
export function stopMongo() {
  docker(['rm', '-fv', MONGO_CONTAINER])
  docker(['network', 'rm', NETWORK])
}

function mongosh(db, args) {
  return dockerOk(['exec', MONGO_CONTAINER, 'mongosh', '--quiet', db, ...args]).stdout.trim()
}

/** dbHash of the old invoice stores: the proof that an undo changes nothing. */
function oldStoresHash(db) {
  const eval_ = `const r=db.runCommand({dbHash:1,collections:${JSON.stringify(OLD_STORES)}});print(JSON.stringify(r.collections))`
  return mongosh(db, ['--eval', eval_])
}

/** A Backend script in a one-off container that shares the database's network, so the URI is localhost. */
function backend(db, args, env = {}) {
  const envArgs = Object.entries({
    MONGODB_URI: `mongodb://localhost:27017/${db}`, JWT_SECRET: 'rehearsal', SESSION_SECRET: 'rehearsal', NODE_ENV: 'development', ISOPLUS_OFFLINE: '1', LOGGER_MONGO: 'off', ...env,
  }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const mounts = ['migrations', 'scripts', 'src'].flatMap((d) => ['-v', `${join(BACKEND, d)}:/app/${d}:ro`])
    .concat(['-v', `${join(BACKEND, 'migrate.json')}:/app/migrate.json:ro`])
  return docker(['run', '--rm', '--network', `container:${MONGO_CONTAINER}`, ...envArgs, ...mounts, BACKEND_IMAGE, 'node', ...args])
}

const backendOk = (db, args, env) => {
  const res = backend(db, args, env)
  if (res.code !== 0) throw new Error(`${args[0]} ${args.slice(1, 3).join(' ')} failed:\n${stripAnsi(res.out).slice(-1200)}`)
  return stripAnsi(res.out)
}

// ---- prepare: an Atlas snapshot download becomes a dump archive ---------------------------------

/** Atlas download (.tgz of raw storage files, or the extracted folder) to a mongodump archive. */
export async function prepare({ input, out, db }) {
  const work = mkdtempSync(join(tmpdir(), 'isoplus-prepare-'))
  let dataDir = input
  if (/\.(tgz|tar\.gz)$/.test(input)) {
    const extracted = spawnSync('tar', ['-xzf', input, '-C', work], { stdio: 'inherit' })
    if (extracted.status !== 0) throw new Error('tar could not extract the snapshot.')
    const dirs = readdirSync(work)
    dataDir = dirs.length === 1 ? join(work, dirs[0]) : work
  }
  const name = 'isoplus-rehearsal-prepare'
  docker(['rm', '-fv', name])
  try {
    dockerOk(['run', '-d', '--name', name, '--network', 'none', '-v', `${dataDir}:/data/db`, MONGO_IMAGE, 'mongod', '--dbpath', '/data/db', '--bind_ip', '127.0.0.1', '--wiredTigerCacheSizeGB', '1'])
    waitForMongo(name)
    const dbs = JSON.parse(dockerOk(['exec', name, 'mongosh', '--quiet', '--eval', 'print(JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>d.name)))']).stdout.trim())
    const candidates = dbs.filter((d) => !['admin', 'config', 'local'].includes(d))
    const wanted = db ? candidates.filter((d) => d === db) : candidates
    if (wanted.length !== 1) throw new Error(`Name the application database with --db. The snapshot holds: ${candidates.join(', ') || 'none'}.`)
    mkdirSync(dirname(resolve(out)), { recursive: true, mode: 0o700 })
    await new Promise((resolvePromise, reject) => {
      const child = spawn('docker', ['exec', name, 'mongodump', '--quiet', '--db', wanted[0], '--archive', '--gzip'], { stdio: ['ignore', 'pipe', 'inherit'] })
      const file = createWriteStream(resolve(out), { mode: 0o600 })
      child.stdout.pipe(file)
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`mongodump exited ${code}`))))
    })
    return { database: wanted[0], archive: resolve(out) }
  } finally {
    docker(['rm', '-fv', name])
    rmSync(work, { recursive: true, force: true })
  }
}

// ---- the run -----------------------------------------------------------------------------------

/** The audit's violation counts. It exits 1 when it finds violations: a finding, not a crash. */
function auditSummary(db) {
  const result = backend(db, ['scripts/invoice-audit.mjs', '--all', '--json'])
  if (result.code > 1) throw new Error(`invoice-audit failed:\n${stripAnsi(result.out).slice(-800)}`)
  try {
    return summariseAudit(JSON.parse(stripAnsi(result.stdout)))
  } catch {
    throw new Error(`invoice-audit did not print JSON (exit ${result.code}):\n${stripAnsi(result.out).slice(-800)}`)
  }
}

function timed(stages, name, fn) {
  const started = Date.now()
  try {
    const detail = fn()
    stages.push({ name, ok: true, seconds: Math.round((Date.now() - started) / 1000), detail: detail || '' })
    return true
  } catch (err) {
    stages.push({ name, ok: false, seconds: Math.round((Date.now() - started) / 1000), detail: String(err.message).split('\n')[0] })
    return false
  }
}

const EXPECTED_PATHS = [
  'restore.collections.items', 'migrations.applied',
  'backfill.created.log-only', 'backfill.created.xero-later', 'backfill.created.xero-only',
  'backfill.found.unplaceable', 'backfill.found.unplaceableLedgerRows', 'backfill.found.deletedItems',
  'backfill.found.duplicateNumbers', 'backfill.found.xeroSpansInvoices', 'backfill.found.supersededByXero',
  'backfill.found.supersededPortalInvoices', 'markers.toMark', 'markers.fromXero', 'markers.fromPdf', 'audit.markerWithoutInvoice',
]

/** The whole rehearsal, stages 0 to 3. Returns { ok, stages, actual, diffs, reportFile }. */
export async function run(options) {
  assertPrerequisites()
  try {
    return await runStages(options)
  } finally {
    // A crash must not leave a container with an unscrubbed copy running.
    if (!options.keep) stopMongo()
  }
}

async function runStages({ archive, sourceDb, expectFile, learn = false, outDir, keep = false }) {
  if (!sourceDb) throw new Error('Name the database inside the archive with --source-db (for production it is "iso-plus"; `prepare` prints it).')
  if (!existsSync(archive)) throw new Error(`Archive not found: ${archive}`)
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const db = `isoplus-rehearsal-${runId.slice(0, 19).toLowerCase()}`
  const dir = outDir || join(homedir(), 'isoplus-rehearsal-runs', runId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stages = []
  const actual = {}
  const keepGoing = () => stages.every((s) => s.ok)

  timed(stages, '0a start a throwaway MongoDB 8.0', () => { startMongo() })
  if (keepGoing()) {
    const started = Date.now()
    const ok = await pipeFile(archive, ['exec', '-i', MONGO_CONTAINER, 'mongorestore', '--quiet', '--archive', '--gzip', '--nsFrom', `${sourceDb}.*`, '--nsTo', `${db}.*`])
      .then(() => true, (err) => { stages.push({ name: '0b restore the dump', ok: false, detail: String(err.message).split('\n')[0] }); return false })
    if (ok) {
      const items = Number(mongosh(db, ['--eval', 'print(db.items.countDocuments())']).split('\n').pop())
      actual.restore = { collections: { items } }
      stages.push({ name: '0b restore the dump', ok: items > 0, seconds: Math.round((Date.now() - started) / 1000), detail: items > 0 ? `${items} items` : `0 items: is "${sourceDb}" the database name inside the archive?` })
    }
  }
  if (keepGoing()) {
    timed(stages, '0c scrub, then verify nothing sensitive is left', () => {
      dockerOk(['cp', join(REPO, 'scripts', 'rehearse', 'scrub.js'), `${MONGO_CONTAINER}:/tmp/scrub.js`])
      const result = JSON.parse(mongosh(db, ['--file', '/tmp/scrub.js']).split('\n').pop())
      actual.scrub = result
      const left = Object.entries(result.after).filter(([, n]) => n !== 0)
      if (left.length) throw new Error(`still present after the scrub: ${left.map(([k, n]) => `${k}=${n}`).join(', ')}`)
      return `${Object.values(result.before).reduce((a, b) => a + b, 0)} sensitive rows removed or cleared`
    })
  }
  let baseline = null
  if (keepGoing()) timed(stages, '1 migrations: every pending one, in order, timed', () => {
    const pending = parsePendingMigrations(backendOk(db, ['scripts/migrate.mjs', 'list']))
    const started = Date.now()
    backendOk(db, ['scripts/migrate.mjs', 'up'])
    const left = parsePendingMigrations(backendOk(db, ['scripts/migrate.mjs', 'list']))
    if (left.length) throw new Error(`still pending after up: ${left.join(', ')}`)
    actual.migrations = { applied: pending.length, seconds: Math.round((Date.now() - started) / 100) / 10 }
    baseline = oldStoresHash(db)
    return `${pending.length} applied in ${actual.migrations.seconds}s`
  })

  const acksFor = (found) => acknowledgements(found)
  let backfillPlan = null
  if (keepGoing()) timed(stages, '2a invoice backfill dry run', () => {
    backfillPlan = parseBackfillDryRun(backendOk(db, ['scripts/invoice-backfill.mjs', '--all']))
    actual.backfill = backfillPlan
    return `${Object.values(backfillPlan.created).reduce((a, b) => a + b, 0)} invoices planned`
  })
  if (keepGoing()) timed(stages, '2b invoice backfill apply, every category acknowledged', () => {
    backendOk(db, ['scripts/invoice-backfill.mjs', '--all', '--apply', '--plan', backfillPlan.planHash, ...acksFor(backfillPlan.found)])
  })
  let markerPlan = null
  if (keepGoing()) timed(stages, '2c marker backfill dry run and apply', () => {
    markerPlan = parseMarkerDryRun(backendOk(db, ['scripts/invoice-marker-backfill.mjs', '--all']))
    actual.markers = markerPlan
    backendOk(db, ['scripts/invoice-marker-backfill.mjs', '--all', '--apply', '--plan', markerPlan.planHash])
    return `${markerPlan.toMark} markers`
  })
  if (keepGoing()) timed(stages, '2d audit', () => {
    const audit = auditSummary(db)
    actual.audit = audit
    return Object.entries(audit).map(([k, n]) => `${k}=${n}`).join(', ') || 'no violations'
  })
  if (keepGoing()) timed(stages, '3a a second run creates and marks nothing', () => {
    const again = parseBackfillDryRun(backendOk(db, ['scripts/invoice-backfill.mjs', '--all']))
    const marks = parseMarkerDryRun(backendOk(db, ['scripts/invoice-marker-backfill.mjs', '--all']))
    if (Object.keys(again.created).length || marks.toMark) throw new Error(`not idempotent: ${JSON.stringify(again.created)} / ${marks.toMark} markers`)
  })
  if (keepGoing()) timed(stages, '3b undo restores the old stores exactly, then apply again', () => {
    backendOk(db, ['scripts/invoice-marker-backfill.mjs', '--all', '--undo', '--apply'])
    backendOk(db, ['scripts/invoice-backfill.mjs', '--all', '--undo', '--apply'])
    if (oldStoresHash(db) !== baseline) throw new Error('the database hash after undo differs from before the backfill')
    const replan = parseBackfillDryRun(backendOk(db, ['scripts/invoice-backfill.mjs', '--all']))
    if (replan.planHash !== backfillPlan.planHash) throw new Error(`the plan after undo differs from the first plan (${replan.planHash} against ${backfillPlan.planHash})`)
    backendOk(db, ['scripts/invoice-backfill.mjs', '--all', '--apply', '--plan', replan.planHash, ...acksFor(replan.found)])
    const remark = parseMarkerDryRun(backendOk(db, ['scripts/invoice-marker-backfill.mjs', '--all']))
    backendOk(db, ['scripts/invoice-marker-backfill.mjs', '--all', '--apply', '--plan', remark.planHash])
    const again = auditSummary(db)
    if (JSON.stringify(again) !== JSON.stringify(actual.audit)) throw new Error(`the audit after undo and re-apply differs: ${JSON.stringify(again)}`)
  })

  let diffs = []
  let draftFile = null
  if (learn) {
    const seen = ['backfill.created', 'backfill.found'].flatMap((o) => Object.keys(o.split('.').reduce((n, k) => (n || {})[k], actual) || {}).map((k) => `${o}.${k}`))
    draftFile = join(dir, 'expectations.draft.json')
    if (keepGoing()) writeFileSync(draftFile, JSON.stringify(draftExpectations(actual, [...new Set([...EXPECTED_PATHS, ...seen])]), null, 2))
  } else if (expectFile && keepGoing()) {
    const expectations = JSON.parse(readFileSync(isAbsolute(expectFile) ? expectFile : join(REPO, expectFile), 'utf8')).expectations
    diffs = [...compareExpectations(actual, expectations), ...unexpectedKeys(actual, expectations, ['backfill.created', 'backfill.found'])]
    stages.push({ name: 'expectations', ok: diffs.length === 0, detail: diffs.length ? `${diffs.length} differ` : 'all as expected' })
  }
  const reportFile = join(dir, 'report.json')
  writeFileSync(reportFile, JSON.stringify({ runId, database: db, stages, actual, diffs }, null, 2), { mode: 0o600 })
  const ok = stages.every((st) => st.ok)
  return { ok, stages, diffs, reportFile, draftFile, summary: summariseStages(stages) + (ok ? '' : '\nStages after the first failure were not run.') }
}

// ---- redact: a copy of production that is safe to share ------------------------------------------------

/**
 * Restore a dump into a throwaway MongoDB, scrub it, redact it (scripts/rehearse/redact.js), PROVE that no
 * replaced original value is left anywhere (an export of every collection searched for each one), and
 * write the redacted dump. Fails, and writes nothing, if any original value survives.
 */
export async function redact({ archive, sourceDb, out, keep = false }) {
  assertPrerequisites()
  if (!sourceDb) throw new Error('Name the database inside the archive with --source-db.')
  const db = 'isoplus-redacted'
  try {
    startMongo()
    await pipeFile(archive, ['exec', '-i', MONGO_CONTAINER, 'mongorestore', '--quiet', '--archive', '--gzip', '--nsFrom', `${sourceDb}.*`, '--nsTo', `${db}.*`])
    for (const script of ['scrub.js', 'redact.js']) dockerOk(['cp', join(REPO, 'scripts', 'rehearse', script), `${MONGO_CONTAINER}:/tmp/${script}`])
    const scrub = JSON.parse(mongosh(db, ['--file', '/tmp/scrub.js']).split('\n').pop())
    const left = Object.entries(scrub.after).filter(([, n]) => n !== 0)
    if (left.length) throw new Error(`still present after the scrub: ${left.map(([k, n]) => `${k}=${n}`).join(', ')}`)
    const redacted = dockerOk(['exec', MONGO_CONTAINER, 'mongosh', '--quiet', db, '--file', '/tmp/redact.js']).stdout
    const patterns = leakPatterns(redacted)
    const work = mkdtempSync(join(tmpdir(), 'isoplus-redact-'))
    try {
      // a purely numeric original (an id, a phone number) is searched as a whole number, so a short one does not
      // match inside a longer number such as a timestamp
      const isNumeric = (value) => /^[\d\s+()-]+$/.test(value)
      writeFileSync(join(work, 'patterns.txt'), `${patterns.filter((v) => !isNumeric(v)).join('\n')}\n`, { mode: 0o600 })
      writeFileSync(join(work, 'numeric.txt'), `${patterns.filter(isNumeric).join('\n')}\n`, { mode: 0o600 })
      dockerOk(['cp', join(work, 'patterns.txt'), `${MONGO_CONTAINER}:/tmp/patterns.txt`])
      dockerOk(['cp', join(work, 'numeric.txt'), `${MONGO_CONTAINER}:/tmp/numeric.txt`])
    } finally {
      // the lists hold every original value, so they never outlive this step
      rmSync(work, { recursive: true, force: true })
    }
    const proof = dockerOk(['exec', MONGO_CONTAINER, 'sh', '-c', `rm -rf /tmp/exp && mkdir -p /tmp/exp && for c in $(mongosh --quiet ${db} --eval 'db.getCollectionNames().join(" ")'); do mongoexport --quiet --db ${db} --collection $c --out /tmp/exp/$c.json 2>/dev/null || { echo EXPORT_FAILED $c; exit 1; }; n=$(( $(grep -F -i -f /tmp/patterns.txt -c /tmp/exp/$c.json) + $(grep -F -w -f /tmp/numeric.txt -c /tmp/exp/$c.json) )); [ "$n" != "0" ] && echo "LEAKED $c $n"; done; echo PROOF_DONE`]).stdout
    const leaked = proof.split('\n').filter((l) => l.startsWith('LEAKED'))
    if (!proof.includes('PROOF_DONE')) throw new Error('the leak check did not finish')
    if (leaked.length) throw new Error(`${patterns.length} original values were checked and some survive (${leaked.join('; ')}). Extend scripts/rehearse/redact.js: nothing was written.`)
    mkdirSync(dirname(resolve(out)), { recursive: true, mode: 0o700 })
    await new Promise((resolvePromise, reject) => {
      const child = spawn('docker', ['exec', MONGO_CONTAINER, 'mongodump', '--quiet', '--db', db, '--archive', '--gzip'], { stdio: ['ignore', 'pipe', 'inherit'] })
      const file = createWriteStream(resolve(out), { mode: 0o600 })
      child.stdout.pipe(file)
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`mongodump exited ${code}`))))
    })
    return { archive: resolve(out), database: db, checked: patterns.length }
  } finally {
    if (!keep) stopMongo()
  }
}
