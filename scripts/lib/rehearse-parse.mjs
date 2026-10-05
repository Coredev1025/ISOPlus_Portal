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
    const got = path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), actual)
    if (JSON.stringify(got) !== JSON.stringify(value)) diffs.push({ path, expected: value, actual: got ?? null, reason })
  }
  return diffs
}

/**
 * Keys present in the run under the given objects (for example `backfill.created`) that no expectation
 * names. A category or reason that appears for the first time is acknowledged by the harness so the run
 * can finish, so it must be flagged here or it would pass unnoticed.
 */
export function unexpectedKeys(actual, expectations, objectPaths) {
  const diffs = []
  for (const objectPath of objectPaths) {
    const node = objectPath.split('.').reduce((n, key) => (n == null ? undefined : n[key]), actual) || {}
    for (const key of Object.keys(node)) {
      if (!(`${objectPath}.${key}` in expectations)) diffs.push({ path: `${objectPath}.${key}`, expected: 'not expected', actual: node[key], reason: 'a new category or reason: decide what it means before accepting it' })
    }
  }
  return diffs
}

/** A draft expectations object from an actual run, for a human to review and commit (`--learn`). */
export function draftExpectations(actual, paths) {
  return Object.fromEntries(paths.map((path) => [path, {
    value: path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), actual) ?? null,
    reason: 'TO CONFIRM: why this number is the right one',
  }]))
}

/** One line per stage for the terminal summary. */
export const summariseStages = (stages) => stages
  .map((stage) => `${stage.ok ? 'PASS' : 'FAIL'}  ${stage.name}${stage.seconds != null ? `  (${stage.seconds}s)` : ''}${stage.detail ? `  ${stage.detail}` : ''}`)
  .join('\n')
