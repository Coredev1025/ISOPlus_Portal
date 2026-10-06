import { describe, it, expect, vi } from 'vitest';
import {
  computeHookBackoffMs,
  isRetryableHookError,
  parseRetryAfterMs,
  resolveHookMaxRetries,
  withHookRetry,
} from '../../../src/utils/hookRetryHelpers.js';

const httpError = (status, headers = {}) => Object.assign(new Error(`status ${status}`), { response: { status, headers } });

describe('hookRetryHelpers', () => {
  it('retries only 429 and 503', () => {
    expect(isRetryableHookError(httpError(429))).toBe(true);
    expect(isRetryableHookError(httpError(503))).toBe(true);
    expect(isRetryableHookError(httpError(404))).toBe(false);
    expect(isRetryableHookError(httpError(500))).toBe(false);
    expect(isRetryableHookError(new Error('boom'))).toBe(false);
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    expect(parseRetryAfterMs('7')).toBe(7000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(parseRetryAfterMs('Tue, 06 Oct 2026 12:00:10 GMT', now)).toBe(10000);
  });

  it('prefers Retry-After, otherwise backs off exponentially, and caps both at 30s', () => {
    expect(computeHookBackoffMs(0, '5')).toBe(5000);
    expect(computeHookBackoffMs(0, '600')).toBe(30000);
    expect(computeHookBackoffMs(0, undefined, () => 0)).toBe(2000);
    expect(computeHookBackoffMs(2, undefined, () => 0)).toBe(8000);
    expect(computeHookBackoffMs(10, undefined, () => 0)).toBe(30000);
  });

  it('reads the retry count from the environment, falling back on bad values', () => {
    expect(resolveHookMaxRetries({})).toBe(5);
    expect(resolveHookMaxRetries({ ISOPLUS_HOOK_MAX_RETRIES: '2' })).toBe(2);
    expect(resolveHookMaxRetries({ ISOPLUS_HOOK_MAX_RETRIES: '0' })).toBe(0);
    expect(resolveHookMaxRetries({ ISOPLUS_HOOK_MAX_RETRIES: 'x' })).toBe(5);
    expect(resolveHookMaxRetries({ ISOPLUS_HOOK_MAX_RETRIES: '-1' })).toBe(5);
  });

  it('waits the hinted time between attempts and stops after maxRetries', async () => {
    const wait = vi.fn().mockResolvedValue();
    const call = vi.fn().mockRejectedValue(httpError(429, { 'retry-after': '3' }));

    await expect(withHookRetry(call, { maxRetries: 2, wait })).rejects.toThrow('status 429');

    expect(call).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[3000], [3000]]);
  });

  it('throws a non-retryable error straight away', async () => {
    const wait = vi.fn();
    const call = vi.fn().mockRejectedValue(httpError(404));

    await expect(withHookRetry(call, { maxRetries: 5, wait })).rejects.toThrow('status 404');

    expect(call).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
