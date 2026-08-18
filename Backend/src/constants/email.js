/**
 * Fixed values for automation email delivery and its SES event pipeline.
 *
 * Touchpoints:
 *   - EMAIL_EVENTS_POLLING            → workers/emailEventsWorker.js
 *   - EMAIL_EVENTS_FAILURE_LIMIT      → workers/emailEventsWorker.js
 *
 * This file imports nothing, per the constants rule in CLAUDE.md.
 */

/**
 * sqs-consumer tuning agreed with the queue's owner: 20s long polling keeps an
 * idle queue at ~3 requests/minute, the 10s heartbeat extends the 30s message
 * lock while a slow batch is still being written. Read-only by convention —
 * nothing freezes this object.
 */
export const EMAIL_EVENTS_POLLING = {
  batchSize: 10,
  waitTimeSeconds: 20,
  visibilityTimeout: 30,
  heartbeatInterval: 10,
};

/**
 * Consecutive handler failures before the consumer stops itself. A handler
 * bug that throws on EVERY message would otherwise march the whole queue into
 * the dead-letter queue five failures at a time; stopped, the messages wait
 * on the main queue while someone investigates, and the stalled-queue alarm
 * fires.
 */
export const EMAIL_EVENTS_FAILURE_LIMIT = 10;
