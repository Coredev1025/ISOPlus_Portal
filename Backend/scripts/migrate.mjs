#!/usr/bin/env node
//
// Wrapper around the ts-migrate-mongoose CLI.
//
//   npm run migrate list
//   npm run migrate create add-archived-flag
//   npm run migrate up
//   npm run migrate down <name>
//
// It exists for one reason: there must be exactly ONE connection string in
// this project. ts-migrate-mongoose wants `uri` (or MIGRATE_MONGO_URI), while
// the app uses MONGODB_URI, and a second copy of a connection string is a
// migration pointed at the wrong database waiting to happen. This resolves
// MONGODB_URI the same way the app does and hands it over as
// MIGRATE_MONGO_URI.
//
// Using the environment variable rather than the -d flag also keeps argument
// order irrelevant, so everything after `migrate` is passed through untouched.
//
// Spawning `process.execPath` with a resolved .js path — rather than the
// node_modules/.bin shim — is what makes this work identically on Windows,
// where the shim is a .cmd that cannot be spawned without a shell.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// In Docker, compose supplies MONGODB_URI directly. Running the backend
// natively, it comes from Backend/.env — load it only if it is not already set.
if (!process.env.MONGODB_URI) {
  const envFile = join(backendRoot, '.env')
  if (existsSync(envFile)) {
    const { config } = await import('dotenv')
    config({ path: envFile })
  }
}

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('error: MONGODB_URI is not set.')
  console.error('  In Docker it is supplied by docker-compose.yml — run migrations with:')
  console.error('    npm run migrate            (from the repo root, execs into the container)')
  console.error('  Running the backend natively, set it in Backend/.env')
  process.exit(1)
}

// Refuse to run against anything that is not obviously local unless the caller
// says so explicitly. Migrations are destructive and irreversible in practice.
const isLocal = /(?:@|\/\/)(?:localhost|127\.0\.0\.1|mongo)[:/]/.test(uri)
if (!isLocal && !process.argv.includes('--allow-remote') && process.argv[2] !== 'list') {
  console.error(`error: MONGODB_URI does not look local: ${uri.replace(/\/\/[^@]*@/, '//***@')}`)
  console.error('  Re-run with --allow-remote if you really mean to migrate a remote database.')
  process.exit(1)
}

// Resolve the CLI next to the package's main entry. The package does not
// expose ./package.json in its exports map, so it cannot be resolved directly.
let cliPath
try {
  cliPath = join(dirname(require.resolve('ts-migrate-mongoose')), 'cli.js')
} catch {
  cliPath = join(backendRoot, 'node_modules', 'ts-migrate-mongoose', 'dist', 'cli.js')
}
if (!existsSync(cliPath)) {
  console.error(`error: could not find the ts-migrate-mongoose CLI at ${cliPath}`)
  console.error('  Has the dependency been installed? In Docker: npm run dev:build from the repo root.')
  process.exit(1)
}

const args = process.argv.slice(2).filter((a) => a !== '--allow-remote')

// `migrate create` always writes a .ts file, but Backend/ is ESM JavaScript
// with no TypeScript toolchain, and the runner happily loads .js. Snapshot the
// directory so the new file can be renamed afterwards.
const migrationsDir = join(backendRoot, 'migrations')
const before = args[0] === 'create' && existsSync(migrationsDir)
  ? new Set(readdirSync(migrationsDir))
  : null

const child = spawn(process.execPath, [cliPath, ...args], {
  cwd: backendRoot,
  stdio: 'inherit',
  env: { ...process.env, MIGRATE_MONGO_URI: uri },
})

child.on('close', (code) => {
  if (code === 0 && before) {
    const created = readdirSync(migrationsDir).filter((f) => !before.has(f) && f.endsWith('.ts'))
    for (const file of created) {
      const asJs = file.replace(/\.ts$/, '.js')
      renameSync(join(migrationsDir, file), join(migrationsDir, asJs))
      console.log(`Renamed to ${asJs} — migrations in this project are plain ESM JavaScript.`)
    }
  }
  process.exit(code ?? 1)
})
