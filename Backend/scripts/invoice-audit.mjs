#!/usr/bin/env node
//
// Check the invoice invariants (KAN-302 / KAN-311). Read only.
//
//   npm run invoice-audit -- --workspace <id> [--workspace <id> ...]
//   npm run invoice-audit -- --all [--json]
//
// Prints, per workspace, each violation (a marker with no invoice, a pointer that disagrees,
// two invoices owning one number, a document with no invoice, a stale pending claim, a total
// that does not match its documents) and each reported case (double-billed, duplicate numbers,
// claims needing repair). Exits 1 if any workspace has a violation.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const all = args.includes('--all')
const workspaces = []
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--workspace') {
    const id = args[i + 1]
    if (!id || id.startsWith('--')) {
      console.error('error: --workspace needs a workspace id.')
      process.exit(2)
    }
    workspaces.push(id)
    i += 1
  } else if (args[i] !== '--all' && args[i] !== '--json') {
    console.error(`error: Unknown option: ${args[i]}`)
    process.exit(2)
  }
}
if (!all && workspaces.length === 0) {
  console.error('error: name the workspaces with --workspace <id> (repeatable), or pass --all.')
  process.exit(2)
}
if (!process.env.MONGODB_URI) {
  console.error('error: MONGODB_URI is not set.')
  process.exit(1)
}

const load = (relative) => import(pathToFileURL(join(backendRoot, relative)).href)
const mongoose = (await import('mongoose')).default
await mongoose.connect(process.env.MONGODB_URI)

let violations = 0
try {
  const { auditInvoices } = await load('src/utils/invoiceLedger/audit.js')
  const { workspacesWithInvoices } = await load('src/utils/invoiceLedger/backfill/loader.js')
  const ids = all ? await workspacesWithInvoices() : workspaces
  const out = {}
  for (const workspaceId of ids) {
    const result = await auditInvoices(workspaceId)
    out[workspaceId] = result
    violations += Object.values(result.violations).reduce((sum, list) => sum + list.length, 0)
  }
  if (asJson) console.log(JSON.stringify(out, null, 2))
  else {
    for (const [workspaceId, result] of Object.entries(out)) {
      const v = Object.entries(result.violations).filter(([, list]) => list.length).map(([k, list]) => `${k} ${list.length}`)
      const r = Object.entries(result.reported).filter(([, list]) => list.length).map(([k, list]) => `${k} ${list.length}`)
      console.log(`${workspaceId}: violations ${v.join(', ') || 'none'}; reported ${r.join(', ') || 'none'}`)
    }
    console.log(violations === 0 ? '\nNo violations.' : `\n${violations} violation(s).`)
  }
} finally {
  await mongoose.disconnect()
}
process.exit(violations === 0 ? 0 : 1)
