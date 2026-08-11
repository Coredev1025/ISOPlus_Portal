import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * instrument.js is imported first by index.js, before anything else, so that
 * Sentry can patch the runtime. Its whole contract is: load .env, and call
 * Sentry.init exactly once with the right options — but only when a DSN is
 * configured, so a developer without one does not ship events anywhere.
 */

const ORIGINAL_ENV = { ...process.env };

async function loadInstrument(env = {}) {
  vi.resetModules();
  delete process.env.SENTRY_DSN;
  Object.assign(process.env, env);

  const init = vi.fn();
  vi.doMock('@sentry/node', () => ({ init }));

  await import('../../src/instrument.js');
  return init;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@sentry/node');
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env.NODE_ENV = 'test';
});

describe('instrument', () => {
  it('does not initialise Sentry when no DSN is configured', async () => {
    const init = await loadInstrument({ SENTRY_DSN: '' });

    expect(init).not.toHaveBeenCalled();
  });

  it('initialises Sentry once with the configured DSN', async () => {
    const init = await loadInstrument({ SENTRY_DSN: 'https://key@sentry.example.com/1' });

    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0][0].dsn).toBe('https://key@sentry.example.com/1');
  });

  it('tags events with the current NODE_ENV', async () => {
    const init = await loadInstrument({
      SENTRY_DSN: 'https://key@sentry.example.com/1',
      NODE_ENV: 'production',
    });

    expect(init.mock.calls[0][0].environment).toBe('production');
  });

  it('falls back to the development environment when NODE_ENV is blank', async () => {
    const init = await loadInstrument({
      SENTRY_DSN: 'https://key@sentry.example.com/1',
      NODE_ENV: '',
    });

    expect(init.mock.calls[0][0].environment).toBe('development');
  });

  it('enables log capture and default PII', async () => {
    const init = await loadInstrument({ SENTRY_DSN: 'https://key@sentry.example.com/1' });

    expect(init.mock.calls[0][0]).toMatchObject({
      enableLogs: true,
      sendDefaultPii: true,
    });
  });

  it('passes no other options, so nothing else is configured by accident', async () => {
    const init = await loadInstrument({ SENTRY_DSN: 'https://key@sentry.example.com/1' });

    expect(Object.keys(init.mock.calls[0][0]).sort())
      .toEqual(['dsn', 'enableLogs', 'environment', 'sendDefaultPii']);
  });

  it('loads the .env file, so a DSN defined only there is still honoured', async () => {
    // dotenv.config() never overwrites an already-set variable, so this asserts
    // the call happens by checking a variable the process did not define.
    vi.resetModules();
    delete process.env.SENTRY_DSN;
    const seen = [];
    vi.doMock('dotenv', () => ({
      default: {
        config: (...args) => {
          seen.push(args);
          return { parsed: {} };
        },
      },
    }));
    vi.doMock('@sentry/node', () => ({ init: vi.fn() }));

    await import('../../src/instrument.js');

    expect(seen).toHaveLength(1);
    vi.doUnmock('dotenv');
  });
});
