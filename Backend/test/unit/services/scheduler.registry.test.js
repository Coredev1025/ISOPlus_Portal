import { describe, it, expect, beforeEach } from 'vitest';
import {
  register,
  resolve,
  tryResolve,
  clearRegistry,
} from '../../../src/services/scheduler/registry.js';
import { AT_MOST_ONCE, AT_LEAST_ONCE } from '../../../src/constants/scheduler.js';

describe('scheduler registry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('resolves a registered handler and its policy', () => {
    const handler = () => 'ok';
    register('demo', { handler, policy: AT_MOST_ONCE });

    const entry = resolve('demo');
    expect(entry.handler).toBe(handler);
    expect(entry.policy).toBe(AT_MOST_ONCE);
  });

  it('throws for an unregistered kind rather than silently doing nothing', () => {
    expect(() => resolve('nope')).toThrow(/not registered/i);
  });

  it('refuses a registration with no policy', () => {
    expect(() => register('demo', { handler: () => {} })).toThrow(/policy/i);
  });

  it('refuses a registration with an unknown policy', () => {
    expect(() =>
      register('demo', { handler: () => {}, policy: 'whenever' }),
    ).toThrow(/policy/i);
  });

  it('refuses a registration with no handler', () => {
    expect(() => register('demo', { policy: AT_MOST_ONCE })).toThrow(/handler/i);
  });

  it('throws TypeError specifically when the handler is not a function', () => {
    // The class is asserted, not just the message: a caller should be able to
    // tell a wrong-type argument apart without string-matching, and asserting
    // only on text would let this be reverted to a generic Error unnoticed.
    expect(() => register('demo', { policy: AT_MOST_ONCE })).toThrow(TypeError);
    expect(() => register('demo', { handler: 'nope', policy: AT_MOST_ONCE })).toThrow(TypeError);
  });

  it('refuses to register the same kind twice', () => {
    register('demo', { handler: () => {}, policy: AT_LEAST_ONCE });
    expect(() =>
      register('demo', { handler: () => {}, policy: AT_LEAST_ONCE }),
    ).toThrow(/already registered/i);
  });

  it('tryResolve resolves a registered handler and its policy, same as resolve', () => {
    const handler = () => 'ok';
    register('demo', { handler, policy: AT_LEAST_ONCE });

    const entry = tryResolve('demo');
    expect(entry.handler).toBe(handler);
    expect(entry.policy).toBe(AT_LEAST_ONCE);
  });

  it('tryResolve returns null for an unregistered kind rather than throwing', () => {
    expect(tryResolve('nope')).toBeNull();
  });
});
