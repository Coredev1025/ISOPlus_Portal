import { describe, it, expect } from 'vitest';
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
