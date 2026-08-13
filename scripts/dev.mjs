#!/usr/bin/env node
//
// ISO+ Portal local development CLI.
//
//   node scripts/dev.mjs up            start this worktree's stack
//   node scripts/dev.mjs down          stop it
//   node scripts/dev.mjs status        what is running, and where
//   node scripts/dev.mjs seed          restore seed/*.gz into Mongo
//   node scripts/dev.mjs schema        declared vs actual schema, and the drift
//   node scripts/dev.mjs migrate ...   run database migrations
//   node scripts/dev.mjs user          local login account with a known password
//   node scripts/dev.mjs agents        unify AGENTS.md + skills across assistants
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
import * as branchLib from './lib/branch.mjs'
import { tickConfig, tickOnce } from './lib/tick.mjs'
import {
  copyAppEnvFiles, missingAppEnvFiles, readEnv, setBackendMongoUri, writeEnv, DEFAULTS,
} from './lib/env.mjs'
import { ask, choose, isInteractive } from './lib/prompt.mjs'
import * as agentsync from './lib/agentsync.mjs'
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

  const rebuild = args.includes('--build')

  // A named volume is populated from the image ONLY when it is empty, so a
  // rebuilt image never reaches an existing node_modules volume — a new
  // dependency would silently stay missing. Recreating the app project's
  // volumes is safe: since mongo and redis moved to the infra project, all
  // that lives here is node_modules and .next, both derived from the lockfile.
  //
  // Unconditional, deliberately. This was once gated on the project having
  // running containers (`docker compose ps -q` returning something), which
  // looked like a sensible "nothing to clean up" check and was not: volumes
  // outlive containers. Rebuilding a *stopped* stack therefore skipped the
  // discard and remounted the stale volume over the freshly built image —
  // exactly the failure the discard exists to prevent, and it cost a
  // reviewer an afternoon on KAN-15, the first branch in a while to add a
  // backend dependency. `down -v` removes the volumes whether or not any
  // container is running, and is a no-op when there is nothing to remove.
  if (rebuild) {
    cyan('discarding this project\'s node_modules/.next volumes so the rebuild takes effect')
    await appStack.exec(['down', '-v'])
  }

  cyan(`starting apps for project "${env.COMPOSE_PROJECT_NAME}" (db: ${env.MONGO_DB})`)
  const upArgs = rebuild ? ['up', '-d', '--build'] : ['up', '-d']
  const result = await appStack.exec(upArgs)
  if (result.code !== 0) fail('docker compose up failed (see output above)')

  // `up` exiting 0 only means containers were created. Gate on health.
  cyan('waiting for backend and frontend to report healthy')
  const appHealth = await docker.waitHealthy(appStack, 300_000)
  if (!appHealth.ok) {
    yellow(`not healthy: ${appHealth.report}`)
    await appStack.exec(['ps'])

    // The overwhelmingly common cause is a node_modules volume older than the
    // current package.json — the branch added a dependency and the volume was
    // never discarded. Node's own error reads like an application bug, so name
    // the real cause rather than leaving a 400-line log as the only clue.
    for (const service of ['backend', 'frontend']) {
      const hint = await docker.staleDependencyHint(appStack, service)
      if (!hint) continue
      yellow(`${service} cannot resolve a dependency: ${hint.trim().slice(0, 160)}`)
      note('This is a node_modules volume older than the branch\'s package.json, not a code bug.')
      note('Fix: npm run dev:build   (rebuilds the image AND discards the stale volume)')
      note('`docker compose build` alone will not work — the volume masks the image.')
    }

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

  // seed/ is gitignored, so a worktree never has its own archive. Fall back to
  // the main clone's, which is where the dump actually lives.
  const explicit = args.find((a) => !a.startsWith('-'))
  const main = wt.mainWorktree(root)
  const archive = explicit
    ? join(root, explicit)
    : (seed.findArchive(root) ?? seed.findArchive(main))

  if (!archive || !existsSync(archive)) {
    red('no seed archive found')
    note(`looked in ${join(root, seed.SEED_DIR)}`)
    if (main !== root) note(`and in ${join(main, seed.SEED_DIR)}`)
    note(`put a mongodump --archive --gzip file there — see ${seed.SEED_DIR}/README.md`)
    process.exit(1)
  }
  if (!archive.startsWith(root)) note(`using the main clone's archive: ${archive}`)

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
  seed.remindAboutLocalUser()
}

// --- migrate ----------------------------------------------------------------

/**
 * Run a database migration inside this worktree's backend container.
 *
 * Going through the container rather than the host is deliberate: the backend's
 * node_modules live in a named volume, never on the host, and the container
 * already has MONGODB_URI pointing at the right database for this worktree —
 * including a --isolated-db one.
 */
async function schema(args) {
  docker.assertDockerAvailable()
  if (!(await docker.containerIds(appStack)).length) {
    red('the backend container is not running')
    note('start it first: npm run dev:up')
    process.exit(1)
  }
  const { code } = await appStack.exec([
    'exec', '-T', 'backend', 'node', 'scripts/schema.mjs', ...args,
  ])
  if (code !== 0) process.exit(code)
}

/**
 * Ensure a local support-admin account with a known password.
 *
 * Runs in the backend container so it uses that worktree's MONGODB_URI and the
 * app's own User model — the password must be hashed by the model's pre('save')
 * hook or POST /api/auth/login will never match it.
 */
async function user(args) {
  docker.assertDockerAvailable()
  if (!(await docker.containerIds(appStack)).length) {
    red('the backend container is not running')
    note('start it first: npm run dev:up')
    process.exit(1)
  }
  const { code } = await appStack.exec([
    'exec', '-T', 'backend', 'node', 'scripts/dev-user.mjs', ...args,
  ])
  if (code !== 0) process.exit(code)
}

/**
 * Load the committed NDIS quote fixture into this worktree's database.
 *
 * Runs in the backend container for the same reason `user` does: node_modules
 * live in a named volume, and the container's MONGODB_URI already points at the
 * right database — including an --isolated-db worktree's own.
 *
 * Complements `seed`, it does not replace it. `seed` restores a real dump and is
 * destructive; this writes a handful of invented documents and is additive.
 */
async function fixture(args) {
  docker.assertDockerAvailable()
  if (!(await docker.containerIds(appStack)).length) {
    red('the backend container is not running')
    note('start it first: npm run dev:up')
    process.exit(1)
  }
  const { code } = await appStack.exec([
    'exec', '-T', 'backend', 'node', 'scripts/dev-fixture.mjs', ...args,
  ])
  if (code !== 0) process.exit(code)
}

async function migrate(args) {
  docker.assertDockerAvailable()

  const running = await docker.containerIds(appStack)
  if (!running.length) {
    red('the backend container is not running')
    note('start it first: npm run dev:up')
    process.exit(1)
  }

  const env = readEnv(root)
  cyan(`migrate ${args.join(' ') || 'list'} — against "${env.MONGO_DB}"`)

  const { code } = await appStack.exec([
    'exec', '-T', 'backend', 'node', 'scripts/migrate.mjs', ...(args.length ? args : ['list']),
  ])
  if (code !== 0) process.exit(code)
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
      const ticket = env.TICKET ?? branchLib.ticketFromBranch(e.branch) ?? '—'
      return [e.branch ?? '(detached)', `${ticket}  ${ports}  db=${env.MONGO_DB}  ${e.path}${here}`]
    }),
  )
}

// Flags that consume the following argument. Without this list, `--type
// feature` leaves "feature" looking like a positional branch name, which
// silently skips every prompt and every validation.
const VALUE_FLAGS = new Set(['--type', '--ticket', '--desc', '--description', '--from', '--every', '--url'])

function parseArgs(args) {
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (VALUE_FLAGS.has(arg)) {
      flags[arg] = args[i + 1]
      i += 1
    } else if (arg.startsWith('-')) {
      flags[arg] = true
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

/**
 * Gather branch details, asking for whatever was not supplied as a flag.
 *
 * Every question has a flag equivalent so this is usable without a TTY; with
 * no TTY and missing details it fails loudly rather than hanging on input.
 */
async function resolveBranchDetails(flags, positional) {
  // An explicit branch name bypasses the questions entirely — needed for
  // checking out a branch that already exists and predates this convention.
  const explicit = positional[0]
  if (explicit) return { branch: explicit, ticket: branchLib.ticketFromBranch(explicit) }

  let type = flags['--type']
  let ticket = flags['--ticket']
  let description = flags['--desc'] ?? flags['--description']

  const needsInput = !type || !ticket || !description
  if (needsInput && !isInteractive()) {
    fail(
      'not a terminal, so nothing can be prompted for.\n' +
        '    Supply everything as flags:\n' +
        '      worktree new --type feature --ticket ISO-412 --desc "time tracking"\n' +
        '    Or pass an existing branch name directly: worktree new feature/ISO-412_time_tracking',
    )
  }

  type ??= await choose(
    'What kind of work is this?',
    branchLib.TYPES.map((t) => ({ value: t.value, label: t.label, hint: t.hint })),
  )

  if (!ticket) {
    ticket = await ask('Ticket number (e.g. ISO-412)', { validate: branchLib.validateTicket })
  } else {
    const error = branchLib.validateTicket(ticket)
    if (error) fail(error)
  }

  description ??= await ask('Short description', { validate: branchLib.validateDescription })

  return {
    branch: branchLib.composeBranch({ type, ticket, description }),
    ticket: branchLib.normaliseTicket(ticket),
    type,
  }
}

async function worktreeNew(args) {
  const { flags, positional } = parseArgs(args)

  if (flags['--help'] || flags['-h']) {
    console.log(`usage: node scripts/dev.mjs worktree new [options]

Asks for the branch type, ticket and description when not supplied.

  --type <feature|bugfix|hotfix>   kind of work
  --ticket <ISO-412>               ticket reference
  --desc "<short description>"     becomes the snake_case branch suffix
  --from <ref>                     base to branch from (default: origin/develop,
                                   or origin/main for a hotfix)
  --isolated-db                    give this worktree its own database

Or pass an existing branch name directly:
  worktree new feature/ISO-412_time_tracking
`)
    return
  }

  const { branch, ticket, type } = await resolveBranchDetails(flags, positional)

  const isolatedDb = Boolean(flags['--isolated-db'])
  const explicitBase = flags['--from']
  const baseRef = explicitBase ?? `origin/${branchLib.defaultBase(type ?? 'feature')}`

  // CLAUDE.md says to open PRs against develop, but 31 of the last 40 merges
  // into main came straight from topic branches. Say so rather than silently
  // going along with it.
  if (/(^|\/)main$/.test(baseRef) && type !== 'hotfix') {
    yellow(`branching from ${baseRef} bypasses develop, where integration happens.`)
    note('That is what a hotfix is for. For anything else, prefer origin/develop.')
  }

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
  // start one step above and step until the OS says the pair is actually free
  // AND no sibling worktree has already reserved it.
  const reserved = new Set()
  for (const entry of wt.listWorktrees(root)) {
    const env = readEnv(entry.path)
    reserved.add(Number(env.FRONTEND_PORT))
    reserved.add(Number(env.BACKEND_PORT))
  }

  const [frontendPort, backendPort] = await findFreePortSet(
    [Number(DEFAULTS.FRONTEND_PORT) + 10, Number(DEFAULTS.BACKEND_PORT) + 10],
    { stride: 10, reserved },
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
  // Recorded so commit messages, PR bodies and `worktree list` can recover it
  // without re-parsing the branch name.
  if (ticket) values.TICKET = ticket

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

  // Backend/.env arrived as a verbatim copy, so it still points at the main
  // clone's database. Anything run natively — migrate, schema, npm run dev in
  // Backend/ — reads it directly, so it has to be repointed at this worktree's
  // database or an isolated worktree is only isolated inside Docker.
  const db = values.MONGO_DB ?? DEFAULTS.MONGO_DB
  const uri = setBackendMongoUri(target, { port: values.MONGO_PORT, db })
  if (uri) note(`Backend/.env MONGODB_URI -> ${uri}`)

  console.log('')
  green(`worktree ready: ${target}`)
  table([
    ['branch', branch],
    ...(ticket ? [['ticket', ticket]] : []),
    ['base', baseRef],
    ['project', values.COMPOSE_PROJECT_NAME],
    ['frontend', `http://localhost:${frontendPort}`],
    ['api', `http://localhost:${backendPort}`],
    ['database', isolatedDb ? `${db} (isolated)` : `${db} (shared)`],
  ])
  console.log('')
  if (isolatedDb) note('seed it before use: npm run seed')
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

  // The fresh copy carries the main clone's MONGODB_URI again, so repoint it.
  const env = readEnv(root)
  const uri = setBackendMongoUri(root, { port: env.MONGO_PORT, db: env.MONGO_DB })
  if (uri) note(`Backend/.env MONGODB_URI -> ${uri}`)
}

// --- agents -----------------------------------------------------------------

const AGENTS_MD_ADVICE = {
  ok: 'symlink -> CLAUDE.md',
  absent: 'missing',
  'wrong-target': 'symlink points somewhere unexpected',
  'broken-on-windows': 'a plain file containing "CLAUDE.md" (symlink lost in checkout)',
  'copy-in-sync': 'a copy, currently identical to CLAUDE.md',
  'copy-diverged': 'a copy that has DIVERGED from CLAUDE.md',
  'missing-source': 'CLAUDE.md itself is missing',
}

/**
 * Unify agent instructions and skills across every assistant.
 *
 * Skills installed by any one tool become visible to all, because each tool's
 * directory is a link to a single canonical directory rather than a copy.
 */
async function agents(args) {
  const check = args.includes('--check')
  let problems = 0

  const md = agentsync.checkAgentsMd(root)
  cyan(`${agentsync.INSTRUCTIONS_ALIAS}: ${AGENTS_MD_ADVICE[md.state]}${md.detail ? ` (${md.detail})` : ''}`)
  if (md.state !== 'ok' && md.state !== 'copy-in-sync') {
    problems += 1
    if (md.state === 'missing-source') {
      fail('CLAUDE.md does not exist — nothing to alias')
    } else if (check) {
      note(`fix with: npm run agents`)
    } else {
      const how = agentsync.repairAgentsMd(root)
      green(`repaired as a ${how}`)
      problems -= 1
    }
  }

  const before = agentsync.inspectSkills(root)
  console.log('')
  cyan(`canonical skills (${agentsync.CANONICAL_SKILLS}): ${before.canonical.length}`)
  for (const s of before.canonical) note(s)

  for (const tool of before.tools) {
    if (tool.state === 'linked') continue
    problems += 1
    console.log('')
    yellow(`${tool.tool} (${tool.dir}) is ${tool.state}, not linked`)
    if (tool.extra.length) note(`has skills the others cannot see: ${tool.extra.join(', ')}`)
    if (tool.missing.length) note(`cannot see: ${tool.missing.join(', ')}`)
  }

  if (check) {
    console.log('')
    if (problems) fail(`${problems} issue(s) — run: npm run agents`)
    green('all assistants share one set of skills')
    return
  }

  const actions = agentsync.unifySkills(root)
  const adopted = actions.filter((a) => a.kind === 'adopt')
  const linked = actions.filter((a) => a.kind === 'link')

  console.log('')
  for (const a of adopted) green(`adopted "${a.skill}" from ${a.tool} into the canonical set`)
  for (const a of linked) green(`${a.tool}: ${a.dir} -> ${agentsync.CANONICAL_SKILLS}`)
  if (!adopted.length && !linked.length) green('already unified — nothing to do')

  const after = agentsync.inspectSkills(root)
  console.log('')
  cyan(`every assistant now sees ${after.canonical.length} skill(s): ${after.canonical.join(', ')}`)
  note('a skill installed by any tool lands in the canonical set automatically')
}

// --- tick ---------------------------------------------------------------------

async function tick(args) {
  const { flags } = parseArgs(args)

  if (flags['--help']) {
    console.log(`usage: node scripts/dev.mjs tick [options]

Calls the scheduler endpoint on an interval — a local stand-in for the
EventBridge rule. Reads the port from .env and SCHEDULER_API_KEY from Backend/.env.

  --once            call once and exit
  --every <secs>    interval between calls (default 60)
  --url <url>       override the endpoint
`)
    return
  }

  const config = tickConfig(process.cwd(), { url: flags['--url'] })

  if (!config.key) {
    console.error('SCHEDULER_API_KEY is not set in Backend/.env — the endpoint will answer 401')
  }

  const run = async () => {
    try {
      console.log(`[${new Date().toISOString()}] ${await tickOnce(config)}`)
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${err.message}`)
    }
  }

  await run()
  if (flags['--once']) return

  const seconds = Number(flags['--every'] || 60)
  console.log(`ticking ${config.url} every ${seconds}s — Ctrl-C to stop`)
  setInterval(run, seconds * 1000)
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

  // rerere replays a conflict resolution the next time the same conflict shows
  // up, which during a rebase is every commit that touched the file. Enabling it
  // is per-clone git config, so it cannot be committed — doctor is where a
  // per-clone setting gets noticed. Reported, not set: doctor diagnoses.
  // `git config --get` exits 1 when the key is unset, so read stdout rather than
  // trusting the exit code.
  const rerere = wt.git(['config', '--get', 'rerere.enabled'], root).stdout === 'true'
  add(
    'git rerere',
    rerere,
    rerere
      ? 'on — conflict resolutions are replayed'
      : 'off — enable with: git config rerere.enabled true && git config rerere.autoUpdate true',
  )

  const archive = seed.findArchive(root)
  add('seed archive', Boolean(archive), archive ? relative(root, archive) : `none in ${seed.SEED_DIR}/`)

  const md = agentsync.checkAgentsMd(root)
  add('AGENTS.md', md.state === 'ok' || md.state === 'copy-in-sync', AGENTS_MD_ADVICE[md.state])

  const unlinked = agentsync.inspectSkills(root).tools.filter((t) => t.state !== 'linked')
  add(
    'agent skills unified',
    unlinked.length === 0,
    unlinked.length ? `${unlinked.map((t) => t.dir).join(', ')} — run: npm run agents` : 'all assistants linked',
  )

  console.log('')
  for (const [state, name, detail] of checks) {
    const mark = state === 'PASS' ? '  ok  ' : ' FAIL '
    console.log(`  [${mark}] ${name.padEnd(22)} ${detail}`)
  }
  console.log('')
  if (checks.some(([s]) => s === 'FAIL')) process.exit(1)
}

// --- dispatch ---------------------------------------------------------------

const COMMANDS = { up, down, status, seed: runSeed, fixture, migrate, schema, user, agents, tick, worktree, doctor }

const [command, ...rest] = process.argv.slice(2)
const handler = COMMANDS[command]

if (!handler) {
  console.log(`usage: node scripts/dev.mjs <command>

  up [--build]                 start this worktree's stack (health-gated)
  down [--all] [-v]            stop it; --all also stops shared infra
  status                       what is running, and on which ports
  seed [file] [--yes]          restore seed/*.gz into Mongo
  fixture [--list] [--remove]  load the committed NDIS quote fixture
  fixture --replay <name> [--dry-run]   POST a recorded ISO+ webhook body
  migrate <list|create|up|down>  run a migration in the backend container
  schema [collection] [--json]  declared vs actual schema, and the drift
  user [--list] [--create]     local support-admin login with a known password
  agents [--check]             unify AGENTS.md + skills across all assistants
  tick [--once] [--every 60]                          drive the scheduler locally
  doctor                       check prerequisites

  worktree new [--type T --ticket ISO-1 --desc "..."]   (asks if omitted)
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
