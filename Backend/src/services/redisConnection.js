import Redis from 'ioredis';

import { info, error, warn } from '../utils/logger.js';

/**
 * Attach the connection listeners sync/queue.js and syncWorker.js each attach
 * to their own client.
 *
 * The 'error' listener is not diagnostics — it is what keeps the process
 * alive. ioredis is an EventEmitter, and an EventEmitter that emits 'error'
 * with no listener registered throws the error out of the event loop, which
 * terminates Node. Both callers of this builder run inside the API process
 * (services/automation/queue.js is imported by the scheduler, and
 * workers/automationWorker.js is started from src/index.js), so a single
 * ElastiCache blip with no listener here takes the whole API down.
 *
 * Returns the client so the builder can `return withConnectionLogging(...)`.
 */
function withConnectionLogging(connection, label) {
  connection.on('connect', () => info(label, 'Redis connection established'));
  connection.on('ready', () => info(label, 'Redis connection ready'));
  connection.on('error', (err) => error(label, 'Redis connection error', {
    error: err.message,
    stack: err.stack,
  }));
  connection.on('close', () => warn(label, 'Redis connection closed'));
  connection.on('reconnecting', (delay) => info(label, 'Redis reconnecting', { delay }));
  return connection;
}

/**
 * A fresh ioredis connection built from the same environment variables
 * sync/queue.js and syncWorker.js read.
 *
 * A builder rather than a shared instance because BullMQ Workers issue
 * blocking commands and must not share a connection with a Queue.
 *
 * Deliberately not retrofitted onto the sync modules, which predate it and
 * construct their own — see the follow-ups in the PR body.
 *
 * TLS handling mirrors sync/queue.js exactly, including the asymmetry: in
 * cluster mode AWS ElastiCache Serverless requires TLS unconditionally, so
 * `tls: {}` is set regardless of REDIS_TLS. Outside cluster mode, TLS is
 * opt-in via REDIS_TLS.
 */
export function buildRedisConnection(label = 'Automation') {
  const host = process.env.REDIS_HOST || 'localhost';
  const port = parseInt(process.env.REDIS_PORT) || 6379;
  const useCluster = process.env.REDIS_CLUSTER === 'true';

  if (useCluster) {
    return withConnectionLogging(new Redis.Cluster([{ host, port }], {
      dnsLookup: (address, callback) => callback(null, address),
      redisOptions: {
        ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
        maxRetriesPerRequest: null,
        tls: {}, // AWS ElastiCache Serverless requires TLS
        connectTimeout: 30000,
      },
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
      lazyConnect: false,
    }), label);
  }

  return withConnectionLogging(new Redis({
    host,
    port,
    ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
    maxRetriesPerRequest: null,
    ...(process.env.REDIS_TLS === 'true' && {
      tls: {
        rejectUnauthorized: false,
      },
    }),
  }), label);
}
