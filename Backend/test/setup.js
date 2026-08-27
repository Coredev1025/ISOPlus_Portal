import { accessSync, constants } from 'node:fs';
import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { server } from './msw/server.js';

function resolveSystemMongod() {
  const candidates = [
    process.env.MONGOMS_SYSTEM_BINARY,
    '/usr/bin/mongod',
    '/usr/local/bin/mongod',
    '/opt/homebrew/bin/mongod',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
    }
  }
  return undefined;
}

// Set at module scope, NOT in beforeAll. Vitest imports this setup file before
// the test file, but `beforeAll` hooks run after it — and every integration test
// calls createApp() at module top level. With NODE_ENV still "development" at
// that moment, app.js takes `isTest === false` and builds a MongoStore session
// store against process.env.MONGODB_URI, which is the real development database
// rather than the in-memory server beforeAll is about to start.
//
// Two consequences, both observed: sessions lived outside the database
// afterEach() truncates, so authenticated requests intermittently came back 401
// instead of their expected status; and running the suite wrote session
// documents into the developer's own business-dashboard.
process.env.NODE_ENV = 'test';

// Pin the suite to the real ISO+ providers, not the offline stand-ins.
//
// isOfflineMode() is implicitly true whenever PERSONAL_ACCESS_TOKEN is blank
// outside production, which is every test run. Without this pin, the moment a
// function in services/isoplus.js gained an offline branch, every test that
// mocks its HTTP call would silently be served from Mongo instead and assert
// against stub data — 34 of them did exactly that when getItemValues gained
// one. Tests that want offline behaviour set the variable themselves and
// restore it (see test/unit/services/offlineIsoplus.test.js); this is the
// documented purpose of the '0' value.
process.env.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE ?? '0';

vi.mock('ioredis', () => {
  class RedisMock {
    constructor() {}
    static Cluster = class ClusterMock {
      constructor() {}
      on() {}
      quit() {}
      disconnect() {}
    };
    on() {}
    quit() {}
    disconnect() {}
  }
  return { default: RedisMock };
});

// Recorded fan-out jobs, read through test/helpers/queue.js.
//
// On globalThis because `vi.mock` factories are hoisted above every
// module-scope binding in this file and cannot close over one. The factory
// body runs on the first import of 'bullmq' from a test file, which is after
// this assignment, so the array is always there by the time addBulk fires.
globalThis.__BULLMQ_BULK_JOBS__ = [];

// Job counts for queue metrics testing.
globalThis.__BULLMQ_JOB_COUNTS__ = null;

vi.mock('bullmq', () => {
  class QueueMock {
    constructor(name) {
      this.name = name;
    }
    on() {}
    add() {
      return { id: 'job_test_1' };
    }
    // The automation fan-out enqueues with addBulk, not add. Without this the
    // mock throws 'addBulk is not a function' and every schedule dispatch is
    // recorded as a handler failure — which reads like a broken scheduler
    // rather than a stale mock, and is why the fan-out went untested through
    // the route for so long.
    addBulk(jobs = []) {
      // Enforce BullMQ's own custom-id rule (Job.validateOptions): a
      // colon-joined jobId is legal only at exactly three parts. Without this
      // the mock accepted ids the real library throws on, so the forced re-run
      // and retry paths passed their integration tests and answered 500 in
      // every deployed environment. A mock that is more permissive than the
      // library it stands in for is not a test double, it is a blind spot.
      for (const job of jobs) {
        const jobId = job?.opts?.jobId;
        if (typeof jobId === 'string' && jobId.includes(':') && jobId.split(':').length !== 3) {
          throw new Error('Custom Id cannot contain :');
        }
      }
      const recorded = jobs.map((job) => ({ ...job, queueName: this.name }));
      globalThis.__BULLMQ_BULK_JOBS__.push(...recorded);
      return recorded.map((job, index) => ({
        id: job.opts?.jobId ?? `job_bulk_${index}`,
      }));
    }
    getWaitingCount() {
      return 0;
    }
    getActiveCount() {
      return 0;
    }
    getFailedCount() {
      return 0;
    }
    getFailed() {
      return [];
    }
    getJobCounts() {
      // A test sets this to an Error to simulate an unreachable Redis, which
      // is how getJobCounts really fails — it rejects, it does not return
      // something malformed.
      if (globalThis.__BULLMQ_JOB_COUNTS__ instanceof Error) {
        throw globalThis.__BULLMQ_JOB_COUNTS__;
      }
      return globalThis.__BULLMQ_JOB_COUNTS__ ?? {
        waiting: 0, active: 0, failed: 0, delayed: 0, completed: 0,
      };
    }
  }
  class WorkerMock {
    constructor() {}
    on() {}
  }
  return { Queue: QueueMock, Worker: WorkerMock };
});

let mongoServer;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test_session_secret';

  const systemBinary = resolveSystemMongod();
  const mongoOptions = systemBinary
    ? { binary: { systemBinary }, instance: { launchTimeout: 60_000 } }
    : { instance: { launchTimeout: 60_000 } };
  mongoServer = await MongoMemoryServer.create(mongoOptions);
  const uri = mongoServer.getUri();
  process.env.MONGODB_URI = uri;

  await mongoose.connect(uri);

  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(async () => {
  server.resetHandlers();

  // In place, not a reassignment: the mock factory captured this array.
  globalThis.__BULLMQ_BULK_JOBS__.length = 0;

  globalThis.__BULLMQ_JOB_COUNTS__ = null;

  const collections = mongoose.connection.collections;
  for (const name of Object.keys(collections)) {
    await collections[name].deleteMany({});
  }
});

afterAll(async () => {
  server.close();
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});
