import { describe, it, expect, beforeEach } from 'vitest';
import { registerSchedulerHandlers } from '../../../src/services/scheduler/handlers.js';
import {
  resolve,
  clearRegistry,
  AT_LEAST_ONCE,
} from '../../../src/services/scheduler/registry.js';

describe('registerSchedulerHandlers', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('registers board_sync under AT_LEAST_ONCE', () => {
    registerSchedulerHandlers();

    const entry = resolve('board_sync');
    expect(typeof entry.handler).toBe('function');
    expect(entry.policy).toBe(AT_LEAST_ONCE);
  });
});
