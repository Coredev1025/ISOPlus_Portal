#!/usr/bin/env node
//
// Fill the invoices collection from the old invoice stores (KAN-302 / KAN-311).
//
//   npm run invoice-backfill -- --workspace <id> [--workspace <id> ...]    DRY RUN (the default)
//   npm run invoice-backfill -- --all
//   npm run invoice-backfill -- --workspace <id> --apply --ack double-billed=3 ...
//   npm run invoice-backfill -- --workspace <id> --undo
//
// A dry run reads the item markers, the document ledger (pdflinks) and the old log
// (invoicenumbers) and prints exactly what a real run would create, plus every category
// that needs a person to look. A real run refuses unless each category found is
// acknowledged with its count (--ack category=count). It only ADDS: it never edits a
// marker, a log row or any other field of an old store. --undo removes what it made.
//
// Needs the invoice-ledger-indexes migration first. Refuses a database that is not local
// unless --allow-remote is given. Design: docs/superpowers/specs/2026-10-04-invoice-source-of-truth-design.md, section 6.

import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isLocalMongoUri } from './devFixtureShape.mjs'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// A one-off script must not write log entries into the database it is working on.
process.env.LOGGER_MONGO = 'off'

if (!process.env.MONGODB_URI) {
  const envFile = join(backendRoot, '.env')
  if (existsSync(envFile)) {
    const { config } = await import('dotenv')
    config({ path: envFile })
  }
}

const load = (relative) => import(pathToFileURL(join(backendRoot, relative)).href)
const { parseBackfillArgs, formatBackfillResult } = await load('src/utils/invoiceLedger/backfill/cli.js')

let options
try {
  options = parseBackfillArgs(process.argv.slice(2))
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(2)
}

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('error: MONGODB_URI is not set.')
  process.exit(1)
}
if (!isLocalMongoUri(uri) && !options.allowRemote) {
  console.error(`error: MONGODB_URI does not look local: ${uri.replace(/\/\/[^@]*@/, '//***@')}`)
  console.error('  Re-run with --allow-remote if you really mean to write to a remote database.')
  process.exit(1)
}

const mongoose = (await import('mongoose')).default
await mongoose.connect(uri)

const printWritten = (written) => console.log(`  written ${written.workspaceId}: created ${written.created}, stamped ${written.stamped}, pointed ${written.pointed}${written.pointerSkipped ? ` (${written.pointerSkipped} skipped: pointer changed)` : ''}, xero attached ${written.xeroAttached}`)

/** The report file holds participant names and item ids: readable by its owner only. */
function writeReportFile(path, result) {
  const { planned, ...printable } = result
  const body = { ...printable, workspaces: (planned || []).map((p) => ({ workspaceId: p.workspaceId, report: p.plan.report, invoices: p.plan.invoices })) }
  writeFileSync(path, JSON.stringify(body, null, 2), { mode: 0o600 })
  console.log(`\nFull report written to ${path} (owner-readable only; it holds participant names)`)
}

let exitCode = 0
try {
  const runModule = await load('src/utils/invoiceLedger/backfill/run.js')
  const { runBackfill, AcknowledgementError, StalePlanError } = runModule
  const { ConflictError } = await load('src/utils/invoiceLedger/backfill/apply.js')
  try {
    const result = await runBackfill({ ...options, onWorkspaceApplied: options.apply && !options.undo ? printWritten : undefined })
    console.log(formatBackfillResult(result).join('\n'))
    if (options.reportFile) writeReportFile(options.reportFile, result)
    if (options.json) console.log(JSON.stringify((({ planned, ...rest }) => rest)(result), null, 2))
  } catch (err) {
    if (![AcknowledgementError, StalePlanError, ConflictError].some((type) => err instanceof type)) throw err
    console.error(`error: ${err.message}`)
    if (err.results?.length) console.error(`  written before it stopped: ${err.results.map((r) => r.workspaceId).join(', ')}. A re-run (dry run first) finishes the rest.`)
    exitCode = 3
  }
} finally {
  await mongoose.disconnect()
}
process.exit(exitCode)
