import { secureRandomFloat } from './securityHelpers.js';

const DEFAULT_MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function resolveHookMaxRetries(env = process.env) {
  const parsed = Number.parseInt(env.ISOPLUS_HOOK_MAX_RETRIES ?? '', 10);
  return Number.isNaN(parsed) || parsed < 0 ? DEFAULT_MAX_RETRIES : parsed;
}

export function isRetryableHookError(err) {
  const status = err?.response?.status;
  return status === 429 || status === 503;
}

/** Seconds or an HTTP date, as ISO+ may send either. Returns milliseconds, or null when absent or unusable. */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(seconds, 0) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(at - now, 0);
}

export function computeHookBackoffMs(attempt, retryAfter, random = secureRandomFloat) {
  const hinted = parseRetryAfterMs(retryAfter);
  if (hinted !== null) return Math.min(hinted, MAX_BACKOFF_MS);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt * (1 + random() * 0.3), MAX_BACKOFF_MS);
}

/**
 * Runs an ISO+ hook call, waiting and trying again when ISO+ answers 429 or 503.
 * Any other error, or the last attempt's, is thrown unchanged for the caller to handle.
 */
export async function withHookRetry(call, { maxRetries = resolveHookMaxRetries(), onRetry, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableHookError(err)) throw err;
      const backoffMs = computeHookBackoffMs(attempt, err.response?.headers?.['retry-after']);
      onRetry?.({ attempt: attempt + 1, maxRetries, backoffMs: Math.floor(backoffMs), status: err.response?.status });
      await wait(backoffMs);
    }
  }
}
