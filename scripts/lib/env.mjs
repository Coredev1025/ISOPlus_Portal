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
