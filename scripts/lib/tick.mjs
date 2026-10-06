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

export const DEFAULT_TICK_SECONDS = 60
export const MIN_TICK_SECONDS = 1
export const TICK_TIMEOUT_MS = 30_000

/**
 * The interval for --every, or an error naming the flag.
 *
 * Number('abc') is NaN and setInterval treats NaN as 1ms, so this used to
 * turn a typo into a thousand requests a second against the local backend.
 * Pure, and returns an error string rather than throwing, matching
 * branchLib.validateTicket.
 */
export function resolveTickInterval(raw, fallback = DEFAULT_TICK_SECONDS) {
  if (raw === undefined || raw === null || raw === '') {
    return { seconds: fallback, error: null }
  }

  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < MIN_TICK_SECONDS) {
    return {
      seconds: null,
      error:
        `--every must be a whole number of seconds, at least ${MIN_TICK_SECONDS} ` +
        `— got "${raw}"`,
    }
  }

  return { seconds, error: null }
}

/**
 * One tick's outcome, as a line an operator reads in a terminal.
 *
 * `heldBack` is printed only when it is non-zero, and printed loudly: it counts
 * due automation schedules the tick deliberately did not claim because
 * AUTOMATION_ENABLED is off. Their slots stay due and are billed when the
 * switch comes on, but "claimed=0 dispatched=0" on its own reads as "nothing
 * was due", which is the misreading this exists to prevent.
 */
export function formatTickSummary(summary) {
  const heldBack = Number(summary?.heldBack) || 0
  return (
    `claimed=${summary.claimed} dispatched=${summary.dispatched} ` +
    `failed=${summary.failed}` +
    `${heldBack > 0 ? ` HELD BACK=${heldBack} (AUTOMATION_ENABLED is off)` : ''}` +
    `${summary.capped ? ' CAPPED' : ''}`
  )
}

/**
 * A printable reason for a failed tick.
 *
 * Node's fetch rejects with a bare "fetch failed" and puts the real reason —
 * ECONNREFUSED, DNS failure, TLS error — in `err.cause`. Printing err.message
 * alone told the developer only that something went wrong, which for a tool
 * whose whole job is talking to a local server is the least useful half.
 *
 * Walks the cause chain, guarding against a self-referential `cause` so a
 * malformed error cannot hang the ticker.
 */
export function describeFetchFailure(err) {
  if (!(err instanceof Error)) return String(err ?? 'unknown error')
  // No duration here: this function cannot know which timeout applied, and
  // an invented number is worse than none. tickOnce, which does know, throws
  // an error that already carries it.
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return 'request timed out'
  }

  const seen = new Set()
  const messages = []
  let current = err

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    messages.push(current.message)
    current = current.cause
  }

  return messages.join(': ')
}

/**
 * One call. Returns a line to print.
 *
 * The timeout matters because the caller ticks on an interval: without it a
 * backend that accepts the connection and never answers leaves the request
 * pending forever, and every later tick stacks up behind it.
 */
export async function tickOnce({ url, key, timeoutMs = TICK_TIMEOUT_MS }) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: key },
      signal: controller.signal,
    })
    const ms = Date.now() - started

    if (!res.ok) {
      const body = await res.text()
      return `${res.status} ${res.statusText} (${ms}ms) ${body.slice(0, 200)}`
    }

    const summary = await res.json()
    return `${formatTickSummary(summary)} (${ms}ms)`
  } catch (err) {
    // Rethrown here rather than described in the catch upstream, because this
    // is the only scope that knows which timeout was actually applied.
    if (err?.name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
