// A local stand-in for the EventBridge rule. Calls the same endpoint on an
// interval so the scheduler is developable with no AWS account.
//
// This is a developer tool, not a fallback inside the application: the app
// deliberately has no timer in it, because one would fire once per Elastic
// Beanstalk instance.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseEnv, readEnv } from './env.mjs'

/** Where to tick, and with what credential. Pure apart from reading the files. */
export function tickConfig(root, overrides = {}) {
  const env = readEnv(root)
  const backendEnvPath = join(root, 'Backend', '.env')
  const backendEnv = existsSync(backendEnvPath)
    ? parseEnv(readFileSync(backendEnvPath, 'utf8'))
    : {}

  return {
    url:
      overrides.url ||
      `http://localhost:${env.BACKEND_PORT}/api/scheduler/tick`,
    key: overrides.key || backendEnv.SCHEDULER_API_KEY || '',
  }
}

/** One call. Returns a line to print. */
export async function tickOnce({ url, key }) {
  const started = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: key },
  })
  const ms = Date.now() - started

  if (!res.ok) {
    const body = await res.text()
    return `${res.status} ${res.statusText} (${ms}ms) ${body.slice(0, 200)}`
  }

  const summary = await res.json()
  return (
    `claimed=${summary.claimed} dispatched=${summary.dispatched} ` +
    `failed=${summary.failed}${summary.capped ? ' CAPPED' : ''} (${ms}ms)`
  )
}
