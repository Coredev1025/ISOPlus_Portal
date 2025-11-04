import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { info, error, warn } from '../../utils/logger.js';

// Redis connection configuration for ElastiCache Cluster
// AWS ElastiCache Serverless uses Redis Cluster mode
const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT) || 6379;

const redisConnection = new Redis.Cluster(
  [{ host: redisHost, port: redisPort }],
  {
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: {
      ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
      maxRetriesPerRequest: null, // Recommended for production
      tls: {}, // AWS ElastiCache Serverless requires TLS
    },
  }
);

// Add connection event listeners for debugging
redisConnection.on('connect', () => {
  info('Sync-Queue', 'Redis connection established');
});

redisConnection.on('ready', () => {
  info('Sync-Queue', 'Redis connection ready');
});

redisConnection.on('error', (err) => {
  error('Sync-Queue', 'Redis connection error', { error: err.message, stack: err.stack });
});

redisConnection.on('close', () => {
  warn('Sync-Queue', 'Redis connection closed');
});

redisConnection.on('reconnecting', (delay) => {
  info('Sync-Queue', 'Redis reconnecting', { delay });
});

// Create sync queue
export const syncQueue = new Queue('board-sync', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    },
    removeOnComplete: {
      age: 24 * 3600, // Keep completed jobs for 24 hours
      count: 1000 // Keep last 1000 completed jobs
    },
    removeOnFail: {
      age: 7 * 24 * 3600 // Keep failed jobs for 7 days
    }
  }
});

info('Sync-Queue', 'BullMQ sync queue initialized', {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379
});

// Queue event listeners
syncQueue.on('error', (err) => {
  error('Sync-Queue', 'Queue error occurred', { error: err.message, stack: err.stack });
});

syncQueue.on('waiting', (jobId) => {
  info('Sync-Queue', 'Job waiting', { jobId });
});

export default syncQueue;

