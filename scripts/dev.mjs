#!/usr/bin/env node
//
// ISO+ Portal local development CLI.
//
//   node scripts/dev.mjs up            start this worktree's stack
//   node scripts/dev.mjs down          stop it
//   node scripts/dev.mjs status        what is running, and where
//   node scripts/dev.mjs seed          restore seed/*.gz into Mongo
//   node scripts/dev.mjs worktree ...  create / list / remove worktrees
//   node scripts/dev.mjs doctor        check prerequisites
//
// Equivalent npm scripts exist for every command (npm run dev:up, and so on).
//
// Written in Node rather than shell so that it behaves identically in
// PowerShell, cmd, bash and zsh — Node 22 is already required by both apps, so
// it is the one interpreter guaranteed to be present. See docs/worktrees.md.

import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'

import * as docker from './lib/docker.mjs'
import * as seed from './lib/seed.mjs'
import * as wt from './lib/worktree.mjs'
import { copyAppEnvFiles, missingAppEnvFiles, readEnv, writeEnv, DEFAULTS } from './lib/env.mjs'
import { findFreePortSet, isPortFree } from './lib/ports.mjs'
import { cyan, green, note, red, table, yellow, fail } from './lib/log.mjs'

const root = wt.repoRoot()
const appStack = docker.app(root)
const infraStack = docker.infra(root)

// --- up ---------------------------------------------------------------------

async function up(args) {
  docker.assertDockerAvailable()

  const missing = missingAppEnvFiles(root)
  if (missing.length) {
    red(`missing env file(s): ${missing.join(', ')}`)
    note('The API calls process.exit(1) on boot without MONGODB_URI, JWT_SECRET and SESSION_SECRET.')
    note('In a worktree: node scripts/dev.mjs worktree sync-env')
    note('In a fresh clone: copy each app\'s .env.example and fill in the secrets.')
    process.exit(1)
  }

  const env = readEnv(root)

  if (!(await docker.containerIds(infraStack)).length) {
    cyan('starting shared infra (mongo, redis)')
    await infraStack.exec(['up', '-d'])
  } else {
    cyan('shared infra already running')
  }

  cyan('waiting for mongo and redis to report healthy')
  const infraHealth = await docker.waitHealthy(infraStack, 120_000)
  if (!infraHealth.ok) {
    fail(`shared infra never became healthy: ${infraHealth.report}\n` +
      '    inspect with: docker compose -f docker-compose.infra.yml logs --tail 40')
  }

  cyan(`starting apps for project "${env.COMPOSE_PROJECT_NAME}" (db: ${env.MONGO_DB})`)
  const upArgs = ['up', '-d']
  if (args.includes('--build')) upArgs.push('--build')
  const result = await appStack.exec(upArgs)
  if (result.code !== 0) fail('docker compose up failed (see output above)')

  // `up` exiting 0 only means containers were created. Gate on health.
  cyan('waiting for backend and frontend to report healthy')
  const appHealth = await docker.waitHealthy(appStack, 300_000)
  if (!appHealth.ok) {
    yellow(`not healthy: ${appHealth.report}`)
    await appStack.exec(['ps'])
    fail('stack did not come up — inspect with: docker compose logs --tail 40')
  }

  if (!(await docker.reportUnpublished(appStack))) {
    fail('a service is unreachable from the host (see above)')
  }

  await report(env)
}

// --- reporting --------------------------------------------------------------

async function probe(url, { expectJson = false } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!expectJson) return { ok: res.ok, detail: `HTTP ${res.status}` }
    const body = await res.text()
    return { ok: res.ok && body.includes('"status":"OK"'), detail: body.trim().slice(0, 60) }
  } catch (err) {
    return { ok: false, detail: `unreachable (${err.name})` }
  }
}

async function report(env) {
  const api = await probe(`http://localhost:${env.BACKEND_PORT}/api/healthcheck`, { expectJson: true })
  const web = await probe(`http://localhost:${env.FRONTEND_PORT}`)

  console.log('')
  green('stack is up')
  table([
    ['Frontend', `http://localhost:${env.FRONTEND_PORT}  ${web.detail}`],
    ['API', `http://localhost:${env.BACKEND_PORT}/api/healthcheck  ${api.detail}`],
    ['Bull Board', `http://localhost:${env.BACKEND_PORT}/api/queues`],
    ['Mongo', `localhost:${env.MONGO_PORT}  db=${env.MONGO_DB}`],
    ['Redis', `localhost:${env.REDIS_PORT}`],
  ])
  console.log('')

  if (!api.ok) yellow('the API healthcheck did not return {"status":"OK"}')
  if (!web.ok) yellow('the frontend did not return a 2xx')
}

// --- down -------------------------------------------------------------------

async function down(args) {
  docker.assertDockerAvailable()
  const wipe = args.includes('-v') || args.includes('--volumes')
  const all = args.includes('--all')

  cyan('stopping this worktree\'s apps')
  await appStack.exec(wipe ? ['down', '-v'] : ['down'])

  if (all) {
    cyan('stopping shared infra')
    if (wipe) yellow('-v with --all wipes the Mongo and Redis data shared by ALL worktrees')
    await infraStack.exec(wipe ? ['down', '-v'] : ['down'])
  } else {
    note('shared infra left running (other worktrees may be using it) — stop it with --all')
  }
}

// --- status -----------------------------------------------------------------

async function status() {
  docker.assertDockerAvailable()
  const env = readEnv(root)

  cyan(`worktree: ${root}`)
  table([
    ['project', env.COMPOSE_PROJECT_NAME],
    ['frontend', `http://localhost:${env.FRONTEND_PORT}`],
    ['api', `http://localhost:${env.BACKEND_PORT}`],
    ['database', env.MONGO_DB],
  ])
  console.log('')

  cyan('shared infra')
  await infraStack.exec(['ps'])
  console.log('')
  cyan('this worktree')
  await appStack.exec(['ps'])
}

// --- seed -------------------------------------------------------------------

async function runSeed(args) {
  docker.assertDockerAvailable()
  const env = readEnv(root)
  const targetDb = env.MONGO_DB

  const explicit = args.find((a) => !a.startsWith('-'))
  const archive = explicit ? join(root, explicit) : seed.findArchive(root)

  if (!archive || !existsSync(archive)) {
    red('no seed archive found')
    note(`put a mongodump --archive --gzip file in ${seed.SEED_DIR}/ — see ${seed.SEED_DIR}/README.md`)
    process.exit(1)
  }

  if (!(await docker.containerIds(infraStack)).length) {
    cyan('starting shared infra first')
    await infraStack.exec(['up', '-d'])
    const health = await docker.waitHealthy(infraStack, 120_000)
    if (!health.ok) fail(`infra never became healthy: ${health.report}`)
  }

  seed.describeDestructive(targetDb, relative(root, archive) || archive)
  if (!args.includes('--yes') && !args.includes('-y')) {
    const ok = await seed.confirm(`Restore into "${targetDb}"?`)
    if (!ok) {
      yellow('aborted')
      return
    }
  }

  cyan(`restoring ${seed.DUMP_DB}.* into ${targetDb}.*`)
  const { code } = await infraStack.exec(seed.restoreArgs(targetDb), {
    input: seed.archiveStream(archive),
  })
  if (code !== 0) fail('mongorestore failed (see output above)')

  const { stdout } = await infraStack.exec(seed.countArgs(targetDb), { capture: true })
  const collections = stdout.trim().split(/\r?\n/).pop()
  green(`restore complete — "${targetDb}" now has ${collections} collections`)
}

// --- worktree ---------------------------------------------------------------

async function worktree(args) {
  const [sub, ...rest] = args
  if (sub === 'list' || !sub) return worktreeList()
  if (sub === 'new') return worktreeNew(rest)
  if (sub === 'remove' || sub === 'rm') return worktreeRemove(rest)
  if (sub === 'sync-env') return worktreeSyncEnv()
  fail(`unknown worktree subcommand "${sub}" (expected: new, list, remove, sync-env)`)
}

function worktreeList() {
  const entries = wt.listWorktrees(root)
  cyan(`${entries.length} worktree(s)`)
  table(
    entries.map((e) => {
      const env = readEnv(e.path)
      const here = e.path === root ? '  <- you are here' : ''
      const ports = `:${env.FRONTEND_PORT}/:${env.BACKEND_PORT}`
      return [e.branch ?? '(detached)', `${ports}  db=${env.MONGO_DB}  ${e.path}${here}`]
    }),
  )
}

async function worktreeNew(args) {
  const branch = args.find((a) => !a.startsWith('-'))
  if (!branch) fail('usage: node scripts/dev.mjs worktree new <branch> [--isolated-db] [--from <ref>]')

  const isolatedDb = args.includes('--isolated-db')
  const fromIndex = args.indexOf('--from')
  const baseRef = fromIndex !== -1 ? args[fromIndex + 1] : 'origin/develop'

  const main = wt.mainWorktree(root)
  const target = wt.worktreePathFor(branch, root)
  const name = wt.slugify(branch)

  if (existsSync(target)) fail(`${target} already exists`)
  wt.ensureWorktreesDir(root)

  // Reuse the branch if it exists locally or on origin; otherwise cut a new one.
  cyan(`creating worktree for "${branch}" at ${target}`)
  let result
  if (wt.branchExists(branch, root)) {
    result = wt.git(['worktree', 'add', target, branch], root)
  } else if (wt.remoteBranchExists(branch, root)) {
    result = wt.git(['worktree', 'add', '--track', '-b', branch, target, `origin/${branch}`], root)
  } else {
    note(`branch does not exist — creating it from ${baseRef}`)
    result = wt.git(['worktree', 'add', '-b', branch, target, baseRef], root)
  }
  if (result.code !== 0) fail(`git worktree add failed: ${result.stderr}`)

  // Free ports for this worktree. The main clone keeps 3100/4001, so worktrees
  // start one step above and step until the OS says the pair is actually free.
  const [frontendPort, backendPort] = await findFreePortSet(
    [Number(DEFAULTS.FRONTEND_PORT) + 10, Number(DEFAULTS.BACKEND_PORT) + 10],
    { stride: 10 },
  )

  const mainEnv = readEnv(main)
  const values = {
    COMPOSE_PROJECT_NAME: `isoplus-${name}`,
    FRONTEND_PORT: String(frontendPort),
    BACKEND_PORT: String(backendPort),
    MONGO_PORT: mainEnv.MONGO_PORT,
    REDIS_PORT: mainEnv.REDIS_PORT,
  }
  if (isolatedDb) values.MONGO_DB = `${DEFAULTS.MONGO_DB}-${name}`

  writeEnv(
    target,
    values,
    [
      '# Generated by scripts/dev.mjs — safe to edit.',
      '#',
      '# Ports were chosen because they were free at creation time. If another',
      '# process has since claimed one, change it here and re-run dev:up.',
    ].join('\n'),
  )

  const { copied, missing } = copyAppEnvFiles(main, target)
  if (copied.length) note(`copied from the main clone: ${copied.join(', ')}`)
  if (missing.length) yellow(`not found in the main clone, create manually: ${missing.join(', ')}`)

  console.log('')
  green(`worktree ready: ${target}`)
  table([
    ['branch', branch],
    ['project', values.COMPOSE_PROJECT_NAME],
    ['frontend', `http://localhost:${frontendPort}`],
    ['api', `http://localhost:${backendPort}`],
    ['database', values.MONGO_DB ?? `${DEFAULTS.MONGO_DB} (shared)`],
  ])
  console.log('')
  note(`cd ${target}`)
  note('npm run dev:up')
}

async function worktreeRemove(args) {
  const nameArg = args.find((a) => !a.startsWith('-'))
  if (!nameArg) fail('usage: node scripts/dev.mjs worktree remove <name-or-path> [--force]')

  const entries = wt.listWorktrees(root)
  const match = entries.find(
    (e) => wt.nameOf(e.path) === nameArg || e.path === nameArg || e.branch === nameArg,
  )
  if (!match) fail(`no worktree matching "${nameArg}" — see: node scripts/dev.mjs worktree list`)
  if (match.path === wt.mainWorktree(root)) fail('refusing to remove the main clone')

  // Stop its stack first, or its containers and volumes are orphaned.
  const env = readEnv(match.path)
  cyan(`stopping the stack for "${env.COMPOSE_PROJECT_NAME}"`)
  await docker.app(match.path).exec(['down', '-v'])

  if (env.MONGO_DB !== DEFAULTS.MONGO_DB) {
    cyan(`dropping its isolated database "${env.MONGO_DB}"`)
    await infraStack.exec([
      'exec', '-T', 'mongo', 'mongosh', '--quiet',
      '--eval', `db.getSiblingDB('${env.MONGO_DB}').dropDatabase()`,
    ])
  }

  cyan(`removing worktree ${match.path}`)
  const force = args.includes('--force') ? ['--force'] : []
  const res = wt.git(['worktree', 'remove', ...force, match.path], root)
  if (res.code !== 0) {
    red(`git worktree remove failed: ${res.stderr}`)
    note('uncommitted changes? re-run with --force to discard them')
    process.exit(1)
  }
  green(`removed ${match.path}`)
}

function worktreeSyncEnv() {
  const main = wt.mainWorktree(root)
  if (main === root) {
    yellow('you are in the main clone — nothing to sync from')
    return
  }
  const { copied, missing } = copyAppEnvFiles(main, root)
  if (copied.length) green(`copied from the main clone: ${copied.join(', ')}`)
  if (missing.length) yellow(`not found in the main clone: ${missing.join(', ')}`)
}

// --- doctor -----------------------------------------------------------------

async function doctor() {
  const checks = []
  const add = (name, ok, detail) => checks.push([ok ? 'PASS' : 'FAIL', name, detail])

  const [major] = process.versions.node.split('.').map(Number)
  add('node >= 20', major >= 20, `found ${process.versions.node}`)

  try {
    docker.assertDockerAvailable()
    add('docker + compose v2', true, 'daemon responding')
  } catch (err) {
    add('docker + compose v2', false, err.message)
  }

  for (const rel of ['Backend/.env', 'Frontend/.env.local']) {
    add(rel, existsSync(join(root, rel)), existsSync(join(root, rel)) ? 'present' : 'missing')
  }

  const env = readEnv(root)
  for (const [label, port] of [
    ['frontend', env.FRONTEND_PORT],
    ['api', env.BACKEND_PORT],
  ]) {
    const free = await isPortFree(Number(port))
    // A port held by this worktree's own running stack is fine, not a conflict.
    add(`${label} port ${port}`, true, free ? 'free' : 'in use (by this stack, or a conflict)')
  }

  const archive = seed.findArchive(root)
  add('seed archive', Boolean(archive), archive ? relative(root, archive) : `none in ${seed.SEED_DIR}/`)

  console.log('')
  for (const [state, name, detail] of checks) {
    const mark = state === 'PASS' ? '  ok  ' : ' FAIL '
    console.log(`  [${mark}] ${name.padEnd(22)} ${detail}`)
  }
  console.log('')
  if (checks.some(([s]) => s === 'FAIL')) process.exit(1)
}

// --- dispatch ---------------------------------------------------------------

const COMMANDS = { up, down, status, seed: runSeed, worktree, doctor }

const [command, ...rest] = process.argv.slice(2)
const handler = COMMANDS[command]

if (!handler) {
  console.log(`usage: node scripts/dev.mjs <command>

  up [--build]                 start this worktree's stack (health-gated)
  down [--all] [-v]            stop it; --all also stops shared infra
  status                       what is running, and on which ports
  seed [file] [--yes]          restore seed/*.gz into Mongo
  doctor                       check prerequisites

  worktree new <branch> [--isolated-db] [--from <ref>]
  worktree list
  worktree remove <name> [--force]
  worktree sync-env            re-copy Backend/.env + Frontend/.env.local
`)
  process.exit(command ? 1 : 0)
}

try {
  await handler(rest)
} catch (err) {
  red(err.message)
  process.exit(1)
}
