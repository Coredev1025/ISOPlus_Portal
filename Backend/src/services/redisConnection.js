import Redis from 'ioredis';

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
export function buildRedisConnection() {
  const host = process.env.REDIS_HOST || 'localhost';
  const port = parseInt(process.env.REDIS_PORT) || 6379;
  const useCluster = process.env.REDIS_CLUSTER === 'true';

  if (useCluster) {
    return new Redis.Cluster([{ host, port }], {
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
    });
  }

  return new Redis({
    host,
    port,
    ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
    maxRetriesPerRequest: null,
    ...(process.env.REDIS_TLS === 'true' && {
      tls: {
        rejectUnauthorized: false,
      },
    }),
  });
}
