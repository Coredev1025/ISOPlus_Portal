#!/usr/bin/env node
//
// Backfill the item invoice markers from the old log (KAN-302 / KAN-312).
//
//   npm run invoice-marker-backfill -- --workspace <id> [--workspace <id> ...]    DRY RUN (the default)
//   npm run invoice-marker-backfill -- --all
//   npm run invoice-marker-backfill -- --workspace <id> --apply --plan <hash>
//   npm run invoice-marker-backfill -- --workspace <id> --undo            PREVIEW; add --apply to do it
//
// In production no item carries an invoice marker and the old log (invoicenumbers) is the only
// record of what was billed. The marker (`invoicedBy`, with `invoicedAt`) is the guard that works
// when the log is not read, so it must exist before automation is enabled. This sets it to the
// logged number exactly as stored, and the date to the log row's, on items that have none. It
// never overwrites a marker, including a pending claim. --undo clears only what it set.
//
// Refuses a database that is not local unless --allow-remote is given. Run the invoice backfill
// (invoice-backfill.mjs) first, so each item's pointer and marker agree.

import { existsSync } from 'node:fs'
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
const { parseBackfillArgs } = await load('src/utils/invoiceLedger/backfill/cli.js')
const { formatMarkerResult } = await load('src/utils/invoiceLedger/markers/cli.js')

let options
try {
  options = parseBackfillArgs(process.argv.slice(2))
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(2)
}

if (Object.keys(options.acks).length > 0 || options.json || options.reportFile) {
  console.error('error: --ack, --json and --report-file are options of invoice-backfill; this script takes --workspace, --all, --apply, --plan, --undo and --allow-remote.')
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

let exitCode = 0
try {
  const { runMarkerBackfill } = await load('src/utils/invoiceLedger/markers/run.js')
  const { StalePlanError } = await load('src/utils/invoiceLedger/backfill/run.js')
  try {
    const result = await runMarkerBackfill({
      ...options,
      onWorkspaceApplied: options.apply && !options.undo ? (w) => console.log(`  written ${w.workspaceId}: marked ${w.marked}`) : undefined,
    })
    console.log(formatMarkerResult(result).join('\n'))
  } catch (err) {
    if (err.results?.length) console.error(`  written before it stopped: ${err.results.map((r) => r.workspaceId).join(', ')}. A re-run (dry run first) finishes the rest.`)
    if (!(err instanceof StalePlanError)) throw err
    console.error(`error: ${err.message}`)
    exitCode = 3
  }
} finally {
  await mongoose.disconnect()
}
process.exit(exitCode)
