#!/usr/bin/env node
//
// Report the current database schema — what the models DECLARE, what the data
// ACTUALLY contains, and where the two disagree.
//
//   npm run schema                  everything
//   npm run schema -- boards        one collection
//   npm run schema -- --json        machine-readable
//
// Written for the case where you are about to add a migration. The models tell
// you what the code expects; the sampled documents tell you what is really in
// there. Migrations go wrong in the gap between those two, so this prints the
// gap explicitly rather than making you infer it.

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (!process.env.MONGODB_URI) {
  const envFile = join(backendRoot, '.env')
  if (existsSync(envFile)) {
    const { config } = await import('dotenv')
    config({ path: envFile })
  }
}

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('error: MONGODB_URI is not set. From the repo root: npm run schema')
  process.exit(1)
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const sampleSize = Number(args.find((a) => a.startsWith('--sample='))?.split('=')[1] ?? 200)
const only = args.find((a) => !a.startsWith('-'))

const mongoose = (await import('mongoose')).default
await mongoose.connect(uri)
const db = mongoose.connection.db

// Importing every model file registers it on the mongoose singleton. They are
// imported for their side effect; the default export is the model.
const modelsDir = join(backendRoot, 'src', 'models')
for (const file of readdirSync(modelsDir).filter((f) => f.endsWith('.js'))) {
  await import(pathToFileURL(join(modelsDir, file)).href)
}

/** Declared shape, from the Mongoose schema. */
function describeModel(model) {
  const paths = {}
  for (const [name, path] of Object.entries(model.schema.paths)) {
    if (name === '__v') continue
    paths[name] = {
      type: path.instance || path.constructor.name,
      required: Boolean(path.isRequired),
      default:
        typeof path.defaultValue === 'function'
          ? `${path.defaultValue.name || 'fn'}()`
          : path.defaultValue,
      ref: path.options?.ref,
      enum: path.enumValues?.length ? path.enumValues : undefined,
      unique: Boolean(path.options?.unique),
    }
  }
  return { model: model.modelName, collection: model.collection.collectionName, paths }
}

/**
 * Observed shape, from a sample of real documents.
 *
 * Sampled rather than exhaustive so this stays fast on large collections. A
 * field present in 100% of the sample is not proof it is present in every
 * document — check before adding a NOT NULL-style assumption to a migration.
 */
async function describeCollection(name) {
  const collection = db.collection(name)
  const count = await collection.estimatedDocumentCount()
  const docs = await collection.aggregate([{ $sample: { size: sampleSize } }]).toArray()

  const fields = {}

  // Flatten to dotted paths so nested fields are reported as accurately as
  // top-level ones — Mongoose declares them that way, and a migration that
  // touches `syncStats.retryCount` needs to know whether it is actually there.
  // Only plain objects are recursed into; Date, ObjectId, Buffer and arrays are
  // leaves, since their internals are not schema.
  const walk = (value, prefix, depth) => {
    for (const [key, child] of Object.entries(value)) {
      if (key === '__v') continue
      const path = prefix ? `${prefix}.${key}` : key
      const type =
        child === null ? 'null' : Array.isArray(child) ? 'Array' : child?.constructor?.name ?? typeof child

      fields[path] ??= { seen: 0, types: new Set() }
      fields[path].seen += 1
      fields[path].types.add(type)

      if (type === 'Object' && depth < 3) walk(child, path, depth + 1)
    }
  }
  for (const doc of docs) walk(doc, '', 0)

  const indexes = await collection.indexes()
  return {
    collection: name,
    documents: count,
    sampled: docs.length,
    indexes: indexes.map((i) => ({ name: i.name, key: i.key, unique: Boolean(i.unique) })),
    fields: Object.fromEntries(
      Object.entries(fields)
        .sort((a, b) => b[1].seen - a[1].seen)
        .map(([k, v]) => [
          k,
          {
            presence: docs.length ? Math.round((v.seen / docs.length) * 100) : 0,
            types: [...v.types].sort(),
          },
        ]),
    ),
  }
}

const models = Object.values(mongoose.models).map(describeModel)
const collectionNames = (await db.listCollections().toArray())
  .map((c) => c.name)
  .filter((n) => !n.startsWith('system.'))
  .sort()

const targets = only
  ? collectionNames.filter((n) => n === only || models.some((m) => m.collection === n && m.model.toLowerCase() === only.toLowerCase()))
  : collectionNames

if (only && !targets.length) {
  console.error(`error: no collection or model matching "${only}"`)
  console.error(`  collections: ${collectionNames.join(', ')}`)
  await mongoose.disconnect()
  process.exit(1)
}

const report = []
for (const name of targets) {
  const observed = await describeCollection(name)
  const declared = models.find((m) => m.collection === name) ?? null

  // The gap that migrations have to close.
  const declaredKeys = declared ? Object.keys(declared.paths) : []
  const observedKeys = Object.keys(observed.fields)

  // Schema-less containers (Mixed, Map) legitimately hold arbitrary keys —
  // Item.data is a whole board's worth of user-defined columns. Comparing their
  // contents against the schema produces hundreds of meaningless findings.
  const freeFormPrefixes = declaredKeys.filter((k) =>
    ['Mixed', 'Map'].includes(declared.paths[k].type),
  )
  const isFreeForm = (key) => freeFormPrefixes.some((p) => key === p || key.startsWith(`${p}.`))

  // Drift against an empty collection is noise: every declared field is
  // trivially "absent" because there is nothing to look at.
  const drift = declared && observed.sampled > 0
    ? {
        // Declared but never seen: adding a default may need a backfill.
        missingFromData: declaredKeys.filter((k) => k !== '_id' && !observedKeys.includes(k)),
        // Present in data but not in the schema: usually a removed field that
        // was never cleaned up, or a field written outside Mongoose.
        //
        // A container object counts as declared when its children are — Mongoose
        // registers `syncStats.retryCount` as a path but not `syncStats` itself.
        undeclaredInModel: observedKeys.filter(
          (k) =>
            k !== '_id' &&
            !declaredKeys.includes(k) &&
            !isFreeForm(k) &&
            !declaredKeys.some((d) => d.startsWith(`${k}.`)),
        ),
        // Declared required but not universally present: a migration that
        // assumes it exists will throw.
        requiredButSparse: declaredKeys.filter(
          (k) => declared.paths[k].required && (observed.fields[k]?.presence ?? 0) < 100,
        ),
      }
    : null

  report.push({ ...observed, declared, drift })
}

if (asJson) {
  console.log(JSON.stringify({ database: db.databaseName, collections: report }, null, 2))
  await mongoose.disconnect()
  process.exit(0)
}

console.log(`# Schema — ${db.databaseName}\n`)
if (!only) {
  const undeclared = collectionNames.filter((n) => !models.some((m) => m.collection === n))
  if (undeclared.length) console.log(`Collections with no Mongoose model: ${undeclared.join(', ')}\n`)
}

for (const entry of report) {
  console.log(`## ${entry.collection}${entry.declared ? ` (model: ${entry.declared.model})` : ' (no model)'}`)
  console.log(`${entry.documents} documents, ${entry.sampled} sampled\n`)

  if (entry.sampled === 0) console.log('_Collection is empty — the "in data" column and drift are not meaningful._\n')

  // Collapse the contents of schema-less containers to a single row.
  const freeForm = Object.entries(entry.declared?.paths ?? {})
    .filter(([, v]) => ['Mixed', 'Map'].includes(v.type))
    .map(([k]) => k)
  const collapsed = (k) => freeForm.some((p) => k.startsWith(`${p}.`))

  const keys = new Set(
    [...Object.keys(entry.fields), ...Object.keys(entry.declared?.paths ?? {})].filter(
      (k) => !collapsed(k),
    ),
  )
  console.log('| field | declared | in data | types |')
  console.log('|---|---|---|---|')
  for (const key of [...keys].sort()) {
    if (key === '_id') continue
    const d = entry.declared?.paths[key]
    const o = entry.fields[key]
    const declaredCell = d
      ? [d.type, d.required ? 'required' : null, d.unique ? 'unique' : null,
         d.default !== undefined ? `default=${JSON.stringify(d.default)}` : null,
         d.ref ? `ref=${d.ref}` : null].filter(Boolean).join(', ')
      : '—'
    console.log(`| \`${key}\` | ${declaredCell} | ${o ? `${o.presence}%` : '—'} | ${o ? o.types.join('/') : '—'} |`)
  }

  for (const p of freeForm) {
    const children = Object.keys(entry.fields).filter((k) => k.startsWith(`${p}.`)).length
    if (children) console.log(`\n\`${p}\` is schema-less and held ${children} distinct keys in the sample.`)
  }

  console.log('\nIndexes:')
  for (const i of entry.indexes) {
    console.log(`  ${i.name}  ${JSON.stringify(i.key)}${i.unique ? '  UNIQUE' : ''}`)
  }

  if (entry.drift) {
    const { missingFromData, undeclaredInModel, requiredButSparse } = entry.drift
    if (missingFromData.length || undeclaredInModel.length || requiredButSparse.length) {
      console.log('\nDrift — read this before writing a migration:')
      if (missingFromData.length) {
        console.log(`  declared but absent from the sample: ${missingFromData.join(', ')}`)
        console.log('    -> existing documents predate the field; a backfill is probably needed.')
      }
      if (undeclaredInModel.length) {
        const shown = undeclaredInModel.slice(0, 15).join(', ')
        const extra = undeclaredInModel.length > 15 ? ` (+${undeclaredInModel.length - 15} more)` : ''
        console.log(`  in the data but not in the model: ${shown}${extra}`)
        console.log('    -> removed from the schema but never cleaned up, or written outside Mongoose.')
      }
      if (requiredButSparse.length) {
        console.log(`  required but not universally present: ${requiredButSparse.join(', ')}`)
        console.log('    -> a migration assuming it exists will throw on the gaps.')
      }
    }
  }
  console.log('')
}

await mongoose.disconnect()
