import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server.js';
import { getBoardHooks, registerHook, unregisterHook } from '../../../src/services/webhookService.js';

describe('webhookService Isoplus hooks', () => {
  it('getBoardHooks returns success with hooks from MSW stub', async () => {
    const result = await getBoardHooks('Bearer tok', 'ws1', 'b1');
    expect(result.success).toBe(true);
    expect(Array.isArray(result.hooks)).toBe(true);
  });

  it('registerHook creates a hook via MSW stub', async () => {
    const result = await registerHook(
      'Bearer tok',
      'ws1',
      'b1',
      ['item.created'],
      'https://example.com/hook'
    );
    expect(result.success).toBe(true);
  });

  it('unregisterHook deletes a hook via MSW stub', async () => {
    const result = await unregisterHook('Bearer tok', 'ws1', 'b1', 'hook_test_1');
    expect(result.success).toBe(true);
  });

  it('getBoardHooks fails without authorization', async () => {
    const result = await getBoardHooks('', 'ws1', 'b1');
    expect(result.success).toBe(false);
  });
});

describe('webhookService rate limiting (KAN-339)', () => {
  const HOOKS = 'https://app.isoplus.online/api/v2/workspaces/ws1/boards/b1/hooks';
  // Retry-After: 0 keeps the retries instant; the real value is whatever ISO+ sends.
  const throttled = () =>
    HttpResponse.json({ message: 'Too Many Attempts.' }, { status: 429, headers: { 'Retry-After': '0' } });

  function failTimes(times, ok) {
    let calls = 0;
    const counter = { get calls() { return calls; } };
    const handler = () => {
      calls += 1;
      return calls <= times ? throttled() : ok();
    };
    return { handler, counter };
  }

  it('registerHook retries a 429 and succeeds once ISO+ lets it through', async () => {
    const { handler, counter } = failTimes(2, () => HttpResponse.json({ id: 'hook_new', secret: 's' }, { status: 201 }));
    server.use(http.post(HOOKS, handler));

    const result = await registerHook('Bearer tok', 'ws1', 'b1', ['item.created'], 'https://example.com/hook');

    expect(result.success).toBe(true);
    expect(result.hookId).toBe('hook_new');
    expect(counter.calls).toBe(3);
  });

  it('unregisterHook retries a 429 instead of giving up on the first one', async () => {
    const { handler, counter } = failTimes(2, () => HttpResponse.json({ deleted: true }, { status: 200 }));
    server.use(http.delete(`${HOOKS}/hook_1`, handler));

    const result = await unregisterHook('Bearer tok', 'ws1', 'b1', 'hook_1');

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);
    expect(counter.calls).toBe(3);
  });

  it('unregisterHook reports failure, not "already removed", when 429 never clears', async () => {
    const { handler } = failTimes(Infinity, () => HttpResponse.json({}));
    server.use(http.delete(`${HOOKS}/hook_1`, handler));

    const result = await unregisterHook('Bearer tok', 'ws1', 'b1', 'hook_1');

    expect(result.success).toBe(false);
    expect(result.message).toBeUndefined();
  });

  it('getBoardHooks retries a 429 and returns the hooks', async () => {
    const { handler } = failTimes(1, () => HttpResponse.json([{ id: 'hook_1' }]));
    server.use(http.get(HOOKS, handler));

    const result = await getBoardHooks('Bearer tok', 'ws1', 'b1');

    expect(result.success).toBe(true);
    expect(result.hooks).toEqual([{ id: 'hook_1' }]);
  });

  it('does not retry a 404 on unregister: the hook really is gone', async () => {
    const { handler, counter } = failTimes(0, () => HttpResponse.json({}, { status: 404 }));
    server.use(http.delete(`${HOOKS}/hook_1`, handler));

    const result = await unregisterHook('Bearer tok', 'ws1', 'b1', 'hook_1');

    expect(result.success).toBe(true);
    expect(counter.calls).toBe(1);
  });
});
