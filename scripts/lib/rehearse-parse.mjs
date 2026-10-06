// Pure helpers for the release rehearsal (docs/roadmap/release-rehearsal.md): parse what the
// Backend scripts print, build the acknowledgement flags, and compare a run with the committed
// expectations. No I/O here, so it is unit tested without Docker or a database.

const ANSI = /\u001B\[[0-9;]*m/g

export const stripAnsi = (text) => String(text).replace(ANSI, '')

/** `superseded-by-xero` to `supersededByXero`, the report's own key. */
export const camel = (kebab) => kebab.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())

/** `supersededByXero` to `superseded-by-xero`, the form `--ack` takes. */
export const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

/** The pending migrations from `migrate list` output, oldest first (lines `down: <name>`). */
export function parsePendingMigrations(listOutput) {
  return stripAnsi(listOutput)
    .split('\n')
    .map((line) => /^down:\s+(\S+)/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[1])
    .sort()
}

/** `migrate list` prints `<timestamp>-<name>`; `migrate up <name>` takes the bare name. */
export const migrationName = (filename) => filename.replace(/^\d+-/, '')

/** The image `npm run dev:build` makes: compose names it `<project>-backend`, and a worktree's .env sets the project. */
export const backendImage = (env) => `${env.COMPOSE_PROJECT_NAME}-backend`

/** The invoice backfill dry run: invoices by reason, categories found with their counts, the plan hash. */
export function parseBackfillDryRun(output) {
  const lines = stripAnsi(output).split('\n')
  const created = {}
  const found = {}
  let section = null
  let planHash = null
  for (const line of lines) {
    if (/^Invoices to create, by reason:/.test(line)) section = 'created'
    else if (/^Categories found/.test(line)) section = 'found'
    else if (/^By workspace:/.test(line)) section = null
    const hash = /^Plan hash:\s+(\S+)/.exec(line)
    if (hash) planHash = hash[1]
    const reason = section === 'created' ? /^\s{2}([a-z-]+)\s+(\d+)\s*$/.exec(line) : null
    if (reason) created[reason[1]] = Number(reason[2])
    const category = section === 'found' ? /^\s{2}([A-Za-z]+)\s+(\d+)\s+--ack\s/.exec(line) : null
    if (category) found[category[1]] = Number(category[2])
  }
  return { created, found, planHash }
}

/** The marker backfill dry run. */
export function parseMarkerDryRun(output) {
  const text = stripAnsi(output)
  const num = (pattern) => {
    const match = pattern.exec(text)
    return match ? Number(match[1]) : null
  }
  const hash = /Plan hash:\s+(\S+)/.exec(text)
  return {
    toMark: num(/items to mark\s+(\d+)/),
    fromXero: num(/from Xero rows\s+(\d+)/),
    fromPdf: num(/from PDF rows\s+(\d+)/),
    alreadyMarked: num(/already marked \(left alone\)\s+(\d+)/),
    planHash: hash ? hash[1] : null,
  }
}

/** The audit's `--json`: violation counts by category, summed over the workspaces. */
export function summariseAudit(auditJson) {
  const totals = {}
  for (const workspace of Object.values(auditJson)) {
    for (const [name, rows] of Object.entries(workspace.violations || {})) {
      if (rows.length > 0) totals[name] = (totals[name] || 0) + rows.length
    }
  }
  return totals
}

/** The value at a dotted path, or undefined. */
const at = (obj, path) => path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj)

/** `--ack category=count` arguments for every category found, so a real run is exactly the plan read. */
export const acknowledgements = (found) => Object.entries(found).flatMap(([name, count]) => ['--ack', `${kebab(name)}=${count}`])

/**
 * Compare actual values with the expectations: `{ path: { value, reason } }` with dotted paths.
 * Returns the differences, each with the reason the expectation was set, so a drift is explained
 * and not just reported. A path the run did not produce counts as a difference.
 */
export function compareExpectations(actual, expectations) {
  const diffs = []
  for (const [path, { value, reason }] of Object.entries(expectations)) {
    const got = at(actual, path)
    if (JSON.stringify(got) !== JSON.stringify(value)) diffs.push({ path, expected: value, actual: got ?? null, reason })
  }
  return diffs
}

/** Objects whose keys are open-ended: a key no expectation names is a new category to decide on. */
export const OPEN_ENDED_PATHS = ['backfill.created', 'backfill.found', 'audit']

/** Dotted paths of every key the run produced under the given objects (for a `--learn` draft). */
export const keyPaths = (actual, objectPaths) => objectPaths.flatMap((objectPath) => Object.keys(at(actual, objectPath) || {}).map((key) => `${objectPath}.${key}`))

/**
 * Keys present in the run under the given objects (for example `backfill.created`) that no expectation
 * names. A category or reason that appears for the first time is acknowledged by the harness so the run
 * can finish, so it must be flagged here or it would pass unnoticed.
 */
export const unexpectedKeys = (actual, expectations, objectPaths) => keyPaths(actual, objectPaths)
  .filter((path) => !(path in expectations))
  .map((path) => ({ path, expected: 'not expected', actual: at(actual, path), reason: 'a new category or reason: decide what it means before accepting it' }))

/** A draft expectations object from an actual run, for a human to review and commit (`--learn`). */
export function draftExpectations(actual, paths) {
  return Object.fromEntries(paths.map((path) => [path, {
    value: at(actual, path) ?? null,
    reason: 'TO CONFIRM: why this number is the right one',
  }]))
}

const CHECKED_KINDS = new Set(['email', 'phone', 'address', 'id', 'name', 'business'])
const NOT_PERSONAL = new Set(['No Specific Location', 'Not Provided', '13 Sample Street', '13 Sample Street Test'])
const OWNER_EMAIL = /^masoud(\+(participant|billing|cc|replyto))?@isoconsultingservices\.com\.au$/i

/**
 * The original values the redaction replaced (its `LEAK:<kind><TAB><value>` lines), as the list the proof
 * searches for in the redacted copy. Only kinds that identify a person or an organisation are searched;
 * fragments, free text and links are not. Placeholders and the owner's own operational addresses are not
 * personal data and would only produce false matches.
 */
export function leakPatterns(redactOutput) {
  const values = new Set()
  for (const line of String(redactOutput).split('\n')) {
    const match = /^LEAK:([a-z0-9]+)\t(.+)$/.exec(line)
    if (!match || !CHECKED_KINDS.has(match[1])) continue
    const value = match[2].trim()
    if (value.length < 5 || value.length > 120 || NOT_PERSONAL.has(value) || OWNER_EMAIL.test(value) || /@example\.com$/i.test(value)) continue
    values.add(value)
    const exponent = exponentForm(value)
    if (exponent) values.add(exponent)
  }
  return [...values].sort()
}

/**
 * mongoexport writes a whole number of ten digits or more as an exponent (12345678901 becomes
 * 1.2345678901E+10), so the proof must search for that spelling too. Null for anything else.
 */
export function exponentForm(value) {
  if (!/^[1-9]\d{9,}$/.test(value)) return null
  return Number(value).toExponential().toUpperCase()
}

/** One line per stage for the terminal summary. */
export const summariseStages = (stages) => stages
  .map((stage) => `${stage.ok ? 'PASS' : 'FAIL'}  ${stage.name}${stage.seconds != null ? `  (${stage.seconds}s)` : ''}${stage.detail ? `  ${stage.detail}` : ''}`)
  .join('\n')
