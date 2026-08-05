// Reading and writing the per-worktree .env that steers docker-compose.yml.
//
// This is deliberately a tiny hand-rolled parser rather than a dependency: the
// repo has no root-level node_modules and these scripts must run on a fresh
// clone before anything is installed.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULTS = {
  FRONTEND_PORT: '3100',
  BACKEND_PORT: '4001',
  MONGO_PORT: '27017',
  REDIS_PORT: '6380',
  MONGO_DB: 'business-dashboard',
  COMPOSE_PROJECT_NAME: 'isoplus-portal',
}

/** Parse a .env file into a plain object. Unquoted, `#` comments, KEY=VALUE. */
export function parseEnv(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** The effective config for a worktree: its .env layered over the defaults. */
export function readEnv(root) {
  const file = join(root, '.env')
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  return { ...DEFAULTS, ...fromFile }
}

export function writeEnv(root, values, header) {
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  writeFileSync(join(root, '.env'), `${header}\n\n${body}\n`, 'utf8')
}

/**
 * Backend/.env and Frontend/.env.local are gitignored, so a fresh worktree has
 * neither — and the API calls process.exit(1) on boot without MONGODB_URI,
 * JWT_SECRET and SESSION_SECRET. Seeding them from the source clone is the
 * step that is easiest to forget and hardest to diagnose.
 */
export const APP_ENV_FILES = [
  join('Backend', '.env'),
  join('Frontend', '.env.local'),
]

export function copyAppEnvFiles(fromRoot, toRoot) {
  const copied = []
  const missing = []
  for (const rel of APP_ENV_FILES) {
    const src = join(fromRoot, rel)
    if (existsSync(src)) {
      copyFileSync(src, join(toRoot, rel))
      copied.push(rel)
    } else {
      missing.push(rel)
    }
  }
  return { copied, missing }
}

export function missingAppEnvFiles(root) {
  return APP_ENV_FILES.filter((rel) => !existsSync(join(root, rel)))
}

/**
 * Point a worktree's Backend/.env at that worktree's own database.
 *
 * Necessary because Backend/.env is copied verbatim from the main clone, so
 * without this every worktree inherits the main clone's MONGODB_URI. Inside
 * Docker that does not matter — docker-compose.yml overrides the key — but
 * anything running natively against the file reads it directly: `npm run
 * migrate`, `npm run schema`, `npm run dev` in Backend/. On an --isolated-db
 * worktree that means a migration silently pointed at the shared database,
 * which is the exact failure isolation was meant to prevent.
 *
 * The previous value is preserved as a comment rather than discarded, since it
 * may have carried credentials or options worth recovering.
 */
export function setBackendMongoUri(root, { host = 'localhost', port, db }) {
  const file = join(root, 'Backend', '.env')
  if (!existsSync(file)) return null

  const uri = `mongodb://${host}:${port}/${db}`
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const out = []
  let replaced = false

  for (const line of lines) {
    if (/^\s*MONGODB_URI\s*=/.test(line)) {
      if (!replaced) {
        out.push('# Replaced by scripts/dev.mjs when this worktree was created.')
        out.push(`# Previous value: ${line.replace(/^\s*MONGODB_URI\s*=/, '').trim()}`)
        out.push(`MONGODB_URI=${uri}`)
        replaced = true
      }
      continue
    }
    out.push(line)
  }

  if (!replaced) {
    out.push('', '# Written by scripts/dev.mjs when this worktree was created.', `MONGODB_URI=${uri}`)
  }

  writeFileSync(file, out.join('\n'), 'utf8')
  return uri
}
