import Redis from 'ioredis';

import { info, error, warn } from '../utils/logger.js';

/**
 * The 'error' listener is not diagnostics: ioredis is an EventEmitter, and one
 * that emits 'error' with no listener terminates Node — here, the API process
 * both callers of this builder run inside.
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
