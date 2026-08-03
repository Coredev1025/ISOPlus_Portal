import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  stripHtmlTags,
  isEmpty,
  RateLimiter,
  batchProcess,
  batchProcessFast,
  processParallel,
  getFrontendBaseUrl,
  getOAuthStateExpiresIn,
  signOAuthState,
  verifyOAuthState,
} from '../../../src/utils/helpers.js';

describe('stripHtmlTags / isEmpty', () => {
  it('strips tags', () => {
    expect(stripHtmlTags('<b>hi</b>')).toBe('hi');
  });

  it('detects empty values', () => {
    expect(isEmpty(undefined)).toBe(true);
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty('')).toBe(true);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty('x')).toBe(false);
    expect(isEmpty([1])).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('processBatches resolves fulfilled and rejected results', async () => {
    const limiter = new RateLimiter({
      batchSize: 2,
      delayBetweenBatches: 1,
      delayBetweenRequests: 1,
    });
    const results = await limiter.processBatches([
      Promise.resolve(1),
      Promise.reject(new Error('fail')),
      Promise.resolve(3),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });

  it('executeWithRetry retries on 429 then succeeds', async () => {
    const limiter = new RateLimiter({ maxRetries: 3, retryDelay: 1 });
    let attempts = 0;
    const result = await limiter.executeWithRetry(async () => {
      attempts += 1;
      if (attempts < 2) {
        const err = new Error('429');
        err.response = { status: 429 };
        throw err;
      }
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });
});

describe('batch helpers', () => {
  it('batchProcess returns values and nulls for failures', async () => {
    const out = await batchProcess(
      [1, 2],
      async (n) => {
        if (n === 2) throw new Error('nope');
        return n * 2;
      },
      { batchSize: 1, delayBetweenBatches: 1, delayBetweenRequests: 1 }
    );
    expect(out[0]).toBe(2);
    expect(out[1]).toBeNull();
  });

  it('batchProcessFast and processParallel map results', async () => {
    const fast = await batchProcessFast([1, 2, 3], async (n) => n + 1, {
      batchSize: 2,
      delayBetweenBatches: 1,
    });
    expect(fast).toEqual([2, 3, 4]);
    const parallel = await processParallel([1, 2], async (n) => n * 3, 1);
    expect(parallel).toEqual([3, 6]);
  });
});

describe('frontend url and oauth state', () => {
  const envKeys = ['FRONTEND_URL', 'ALLOWED_ORIGINS', 'OAUTH_STATE_TTL', 'JWT_SECRET'];
  const saved = {};
  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k];
    process.env.JWT_SECRET = 'jwt-test';
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('getFrontendBaseUrl prefers FRONTEND_URL then ALLOWED_ORIGINS', () => {
    process.env.FRONTEND_URL = 'https://app.example.com/';
    expect(getFrontendBaseUrl()).toBe('https://app.example.com');
    delete process.env.FRONTEND_URL;
    process.env.ALLOWED_ORIGINS = 'https://a.com, https://b.com';
    expect(getFrontendBaseUrl()).toBe('https://a.com');
  });

  it('signs and verifies oauth state', () => {
    expect(getOAuthStateExpiresIn()).toBeTruthy();
    const state = signOAuthState({ workspaceId: 'ws' });
    const verified = verifyOAuthState(state);
    expect(verified.ok).toBe(true);
    expect(verified.payload.workspaceId).toBe('ws');
    expect(verifyOAuthState('bad').ok).toBe(false);
    expect(verifyOAuthState('').reason).toBe('absent');
  });
});
