// Restoring a mongodump archive into the shared local Mongo.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { cyan, note } from './log.mjs'

export const SEED_DIR = 'seed'

/**
 * The dump's own database name. The archive in seed/ was taken from a database
 * called `isoplus`, while the app connects to `business-dashboard` (see
 * Backend/.env.example), so every restore remaps the namespace.
 */
export const DUMP_DB = 'isoplus'

/** Newest *.archive.gz / *.gz in seed/, or null when the directory is empty. */
export function findArchive(root) {
  const dir = join(root, SEED_DIR)
  if (!existsSync(dir)) return null
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.gz'))
    .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return candidates.length ? candidates[0].file : null
}

/**
 * mongorestore flags for an archive streamed on stdin.
 *
 * These are arguments to the infra compose stack, which supplies its own
 * `compose -f docker-compose.infra.yml` prefix.
 *
 * --drop is scoped by --nsInclude, so it only ever drops collections that the
 * archive is about to replace; it does not wipe unrelated databases.
 */
export function restoreArgs(targetDb) {
  return [
    'exec',
    '-T', // no TTY: we are piping the archive in on stdin
    'mongo',
    'mongorestore',
    '--archive',
    '--gzip',
    '--drop',
    `--nsInclude=${DUMP_DB}.*`,
    `--nsFrom=${DUMP_DB}.*`,
    `--nsTo=${targetDb}.*`,
  ]
}

export function archiveStream(file) {
  return createReadStream(file)
}

/** Count collections in the target DB, to verify a restore actually landed. */
export function countArgs(targetDb) {
  return [
    'exec',
    '-T',
    'mongo',
    'mongosh',
    '--quiet',
    '--eval',
    `db.getSiblingDB('${targetDb}').getCollectionNames().length`,
  ]
}

export async function confirm(question) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * A restore replaces the users collection, so any password set by
 * `npm run dev:user` is gone. That presents as "my local login stopped
 * working", which is a confusing thing to rediscover.
 */
export function remindAboutLocalUser() {
  cyan('the users collection was replaced — local login password cleared')
  note('restore it with: npm run dev:user')
}

export function describeDestructive(targetDb, file) {
  cyan('this restore is destructive')
  note(`archive : ${file}`)
  note(`target  : database "${targetDb}" in the shared local Mongo`)
  note(`collections present in the archive will be DROPPED and replaced`)
}
