import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  clearEmailBackends,
  registerEmailBackend,
  resolveEmailBackend,
  selectBackendName,
} from '../../../src/services/email/registry.js';

const noop = { deliver: async () => ({ delivered: false }) };

describe('registerEmailBackend', () => {
  beforeEach(() => clearEmailBackends());

  it('refuses a backend that cannot deliver', () => {
    expect(() => registerEmailBackend('broken', {})).toThrow(/deliver/i);
  });

  it('refuses to shadow a name that is already registered', () => {
    // Silently replacing one would mean a plugin could redirect every
    // customer email by loading after the real backend.
    registerEmailBackend('local', noop);
    expect(() => registerEmailBackend('local', noop)).toThrow(/already registered/i);
  });

  it('resolves a registered backend and names the unregistered one it was asked for', () => {
    registerEmailBackend('local', noop);
    expect(resolveEmailBackend('local')).toBe(noop);
    expect(() => resolveEmailBackend('carrier-pigeon')).toThrow(/carrier-pigeon/);
  });
});

describe('selectBackendName', () => {
  const saved = { EMAIL_BACKEND: process.env.EMAIL_BACKEND };

  beforeEach(() => {
    delete process.env.EMAIL_BACKEND;
    clearEmailBackends();
  });

  afterEach(() => {
    if (saved.EMAIL_BACKEND === undefined) delete process.env.EMAIL_BACKEND;
    else process.env.EMAIL_BACKEND = saved.EMAIL_BACKEND;
    vi.restoreAllMocks();
  });

  it('picks the local outbox when the backend is offline', () => {
    expect(selectBackendName({ offline: true, transportConfigured: false })).toBe('local-outbox');
  });

  it('picks SES when online and the transport is configured', () => {
    expect(selectBackendName({ offline: false, transportConfigured: true })).toBe('ses');
  });

  it('picks nothing when online with no transport, rather than falling back to a file', () => {
    // Writing a preview nobody reads while a client waits for an invoice is
    // the failure mode this whole seam exists to avoid: the caller must be
    // able to see there is no way to send and skip generation entirely.
    expect(selectBackendName({ offline: false, transportConfigured: false })).toBeNull();
  });

  it('honours an explicit EMAIL_BACKEND override, so a new backend needs no code change here', () => {
    process.env.EMAIL_BACKEND = 'carrier-pigeon';
    expect(selectBackendName({ offline: true, transportConfigured: true })).toBe('carrier-pigeon');
  });

  it('ignores a blank override rather than treating it as a backend name', () => {
    process.env.EMAIL_BACKEND = '   ';
    expect(selectBackendName({ offline: true, transportConfigured: false })).toBe('local-outbox');
  });
});
