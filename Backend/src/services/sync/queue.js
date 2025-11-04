import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { info, error } from '../../utils/logger.js';

// Redis connection configuration for ElastiCache
// Replace with your ElastiCache Redis endpoint and port
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379, // Default Redis port
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Recommended for production
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

