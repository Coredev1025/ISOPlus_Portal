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

vi.mock('bullmq', () => {
  class QueueMock {
    constructor() {}
    on() {}
    add() {
      return { id: 'job_test_1' };
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
