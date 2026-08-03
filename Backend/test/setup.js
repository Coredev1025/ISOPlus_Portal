import { beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { server } from './msw/server.js';

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

  mongoServer = await MongoMemoryServer.create({
    instance: {
      args: ['--nounixsocket']
    },
    binary: {
      systemBinary: process.env.MONGODB_SYSTEM_BINARY || '/usr/bin/mongod'
    }
  });

  const uri = mongoServer.getUri();
  process.env.MONGODB_URI = uri;

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 3000,
    autoIndex: true,
  });

  await mongoose.connection.syncIndexes();

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
