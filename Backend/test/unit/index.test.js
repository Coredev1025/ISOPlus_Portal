import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * index.js is the boot script: it validates the environment, configures the
 * shared axios agents, builds the Express app, mounts Bull Board, connects
 * Mongoose and finally listens. Everything happens at import time, so each test
 * re-imports it with the external edges replaced — no server is ever started,
 * no Mongo connection is opened and no Redis is touched.
 */

const ORIGINAL_ENV = { ...process.env };

/** Replaces every boundary index.js reaches for, and records what it was asked to do. */
function installBootDoubles() {
  const record = {
    listenCalls: [],
    connectCalls: [],
    exitCodes: [],
    retriedJobs: 0,
    bullBoardQueues: [],
    basePaths: [],
    sentryErrorHandlers: 0,
    errors: [],
    infos: [],
    warns: [],
  };

  vi.doMock('./instrument.js', () => ({}));
  vi.doMock('../../src/instrument.js', () => ({}));

  vi.doMock('@sentry/node', () => ({
    isInitialized: () => true,
    setupExpressErrorHandler: () => {
      record.sentryErrorHandlers += 1;
    },
  }));

  // Wrap the real mongoose — the models need a genuine Schema — and override
  // only connect(), so no second connection is opened.
  vi.doMock('mongoose', async (importOriginal) => {
    const actual = await importOriginal();
    const real = actual.default ?? actual;
    const wrapped = Object.create(real);
    wrapped.connect = (uri) => {
      record.connectCalls.push(uri);
      return Promise.resolve(real);
    };
    // vi.resetModules() re-imports every model file, but mongoose keeps its
    // compiled models on the singleton — hand the existing one back instead of
    // throwing OverwriteModelError.
    wrapped.model = (name, schema, ...rest) => {
      if (schema && real.models[name]) return real.models[name];
      return real.model(name, schema, ...rest);
    };
    return { ...actual, default: wrapped };
  });

  vi.doMock('../../src/workers/syncWorker.js', () => ({
    default: {},
    checkAndRetryFailedJobs: vi.fn(async () => {
      record.retriedJobs += 1;
    }),
  }));

  vi.doMock('@bull-board/api', () => ({
    createBullBoard: ({ queues }) => {
      record.bullBoardQueues.push(queues.length);
    },
  }));
  vi.doMock('@bull-board/api/bullMQAdapter', () => ({
    BullMQAdapter: class {
      constructor(queue) {
        this.queue = queue;
      }
    },
  }));
  vi.doMock('@bull-board/express', () => ({
    ExpressAdapter: class {
      setBasePath(path) {
        record.basePaths.push(path);
      }

      getRouter() {
        return (_req, _res, next) => next();
      }
    },
  }));

  vi.doMock('connect-mongo', () => ({
    default: { create: () => ({ on: () => {}, get: () => {}, set: () => {}, destroy: () => {} }) },
  }));

  vi.doMock('../../src/utils/logger.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      info: (...args) => record.infos.push(args),
      error: (...args) => record.errors.push(args),
      warn: (...args) => record.warns.push(args),
    };
  });

  return record;
}

/** Imports index.js under the given environment and returns what it did. */
async function boot(env = {}) {
  vi.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:1/boot-test',
    JWT_SECRET: 'jwt',
    SESSION_SECRET: 'session',
    ...env,
  };

  const record = installBootDoubles();

  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    record.exitCodes.push(code);
    throw new Error(`__process_exit_${code}__`);
  });
  const listenSpy = vi
    .spyOn((await import('express')).default.application, 'listen')
    .mockImplementation(function listen(port, callback) {
      record.listenCalls.push({ port, callback });
      return { close: () => {} };
    });

  try {
    await import('../../src/index.js');
  } catch (err) {
    if (!String(err.message).startsWith('__process_exit_')) throw err;
  } finally {
    exitSpy.mockRestore();
    listenSpy.mockRestore();
  }

  return record;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@sentry/node');
  vi.doUnmock('mongoose');
  process.env = { ...ORIGINAL_ENV };
  process.env.NODE_ENV = 'test';
});

describe('boot environment validation', () => {
  it.each(['MONGODB_URI', 'JWT_SECRET', 'SESSION_SECRET'])(
    'exits rather than starting when %s is missing',
    async (missing) => {
      const record = await boot({ [missing]: '' });

      expect(record.exitCodes).toEqual([1]);
      expect(record.listenCalls).toHaveLength(0);
    },
  );

  it('names every missing variable in the log before exiting', async () => {
    const record = await boot({ JWT_SECRET: '', SESSION_SECRET: '' });

    const logged = JSON.stringify(record.errors);
    expect(logged).toContain('JWT_SECRET');
    expect(logged).toContain('SESSION_SECRET');
    expect(logged).not.toContain('MONGODB_URI');
  });

  it('starts when every required variable is present', async () => {
    const record = await boot();

    expect(record.exitCodes).toEqual([]);
    expect(record.listenCalls).toHaveLength(1);
  });

  it('warns, but still starts, when SCHEDULER_API_KEY is missing', async () => {
    // Deliberately not in requiredEnvVars: a scheduler credential must not be
    // able to stop the whole API booting. But its absence is otherwise
    // completely invisible — every other route works and only the tick answers
    // 500, on every EventBridge invocation, forever.
    const record = await boot({ SCHEDULER_API_KEY: '' });

    expect(record.exitCodes).toEqual([]);
    expect(record.listenCalls).toHaveLength(1);
    expect(JSON.stringify(record.warns)).toContain('SCHEDULER_API_KEY');
  });

  it('says nothing about SCHEDULER_API_KEY when it is set', async () => {
    const record = await boot({ SCHEDULER_API_KEY: 'a-key' });

    expect(JSON.stringify(record.warns)).not.toContain('SCHEDULER_API_KEY');
  });
});

describe('boot HTTP client defaults', () => {
  it('gives axios a 30 second default timeout', async () => {
    await boot();
    const axios = (await import('axios')).default;

    expect(axios.defaults.timeout).toBe(30000);
  });

  it('honours HTTP_CLIENT_TIMEOUT_MS', async () => {
    await boot({ HTTP_CLIENT_TIMEOUT_MS: '45000' });
    const axios = (await import('axios')).default;

    expect(axios.defaults.timeout).toBe(45000);
  });

  it('never drops the timeout below one second', async () => {
    await boot({ HTTP_CLIENT_TIMEOUT_MS: '5' });
    const axios = (await import('axios')).default;

    expect(axios.defaults.timeout).toBe(1000);
  });

  it('keeps connections alive on both http and https agents', async () => {
    await boot();
    const axios = (await import('axios')).default;

    expect(axios.defaults.httpAgent.options.keepAlive).toBe(true);
    expect(axios.defaults.httpsAgent.options.keepAlive).toBe(true);
    expect(axios.defaults.httpAgent.maxSockets).toBe(100);
  });
});

describe('boot listen', () => {
  it('falls back to port 3001 when PORT is not set', async () => {
    // Backend/.env defines PORT, and the logger loads it during import, so an
    // unset variable can be repopulated mid-boot. A blank value exercises the
    // same `||` fallback deterministically.
    const record = await boot({ PORT: '' });

    expect(record.listenCalls[0].port).toBe(3001);
  });

  it('uses the configured PORT', async () => {
    const record = await boot({ PORT: '4001' });

    expect(record.listenCalls[0].port).toBe('4001');
  });
});

describe('boot Mongo connection', () => {
  it('connects with the configured URI', async () => {
    const record = await boot({ MONGODB_URI: 'mongodb://127.0.0.1:1/custom' });

    expect(record.connectCalls).toEqual(['mongodb://127.0.0.1:1/custom']);
  });
});

describe('boot queue monitoring', () => {
  it('mounts Bull Board under /api/queues', async () => {
    const record = await boot();

    expect(record.basePaths).toEqual(['/api/queues']);
  });

  it('registers exactly the sync queue', async () => {
    const record = await boot();

    expect(record.bullBoardQueues).toEqual([1]);
  });
});

describe('boot Sentry wiring', () => {
  it('installs the Sentry error handler when Sentry initialised', async () => {
    const record = await boot();

    expect(record.sentryErrorHandlers).toBe(1);
  });
});

describe('boot startup job retry', () => {
  it('retries failed jobs three seconds after the server starts', async () => {
    vi.useFakeTimers();
    const record = await boot();

    await record.listenCalls[0].callback();
    expect(record.retriedJobs).toBe(0);

    await vi.advanceTimersByTimeAsync(3000);
    expect(record.retriedJobs).toBe(1);

    vi.useRealTimers();
  });

  it('does not retry before the delay elapses', async () => {
    vi.useFakeTimers();
    const record = await boot();

    await record.listenCalls[0].callback();
    await vi.advanceTimersByTimeAsync(2999);

    expect(record.retriedJobs).toBe(0);
    vi.useRealTimers();
  });

  it('logs the port it is listening on', async () => {
    vi.useFakeTimers();
    const record = await boot({ PORT: '4001' });

    await record.listenCalls[0].callback();

    expect(JSON.stringify(record.infos)).toContain('4001');
    vi.useRealTimers();
  });
});

describe('boot process-level error handlers', () => {
  it('registers handlers for unhandled rejections and uncaught exceptions', async () => {
    const before = {
      rejection: process.listenerCount('unhandledRejection'),
      exception: process.listenerCount('uncaughtException'),
    };

    await boot();

    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(before.rejection);
    expect(process.listenerCount('uncaughtException')).toBeGreaterThan(before.exception);
  });
});
