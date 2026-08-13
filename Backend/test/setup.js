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
  const mongoOptions = systemBinary ? { binary: { systemBinary } } : {};
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
