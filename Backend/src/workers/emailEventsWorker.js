// Polls the SQS queue where SES publishes sending events (Delivery, Bounce,
// Complaint, DeliveryDelay, Reject, Rendering Failure) and records each one.
// A poller, deliberately not a webhook: nothing here is publicly reachable,
// there is no signature to verify, and the queue holds messages for 14 days
// if this consumer is down.
//
// Inert by design when SES_EVENTS_QUEUE_URL is unset — an environment without
// the queue boots and runs exactly as before. Same pattern as the automation
// worker's AUTOMATION_ENABLED gate.

import { Consumer } from 'sqs-consumer';
import { SQSClient } from '@aws-sdk/client-sqs';

import { EMAIL_EVENTS_FAILURE_LIMIT, EMAIL_EVENTS_POLLING } from '../constants/email.js';
import { applyDeliveryEvent } from '../services/email/deliveryEvents.js';
import { parseSesEventMessage, recordEmailEvent } from '../services/email/events.js';
import { info, warn, error } from '../utils/logger.js';

const LOG_LABEL = 'Email-Events';

function envValue(name) {
  return String(process.env[name] ?? '').trim();
}

/** True only when the queue URL, credential and region are all present. */
export function isEmailEventsConfigured() {
  return Boolean(
    envValue('SES_EVENTS_QUEUE_URL')
    && envValue('AWS_ACCESS_KEY_ID')
    && envValue('AWS_SECRET_ACCESS_KEY')
    && envValue('AWS_REGION'),
  );
}

/**
 * One SQS message → one stored event. Failures THROW: sqs-consumer only
 * deletes a message after this resolves, so a throw returns the message to
 * the queue for redelivery (and to the DLQ after five attempts). Swallowing
 * the error here would delete the event unrecorded.
 */
export async function handleEmailEventMessage(message) {
  const parsed = parseSesEventMessage(message.Body);
  if (parsed.envelopeWrapped) {
    // RawMessageDelivery is ON for this subscription, so an SNS envelope
    // means the infrastructure changed. Recorded anyway, flagged loudly.
    warn(LOG_LABEL, 'Event arrived SNS-enveloped; raw delivery should be on — the SNS→SQS subscription changed', {
      eventType: parsed.eventType,
      sesMessageId: parsed.sesMessageId,
    });
  }
  const { recorded } = await recordEmailEvent(parsed);
  // After the audit row: the panel state is derived, the EmailEvent row is
  // the record. applyDeliveryEvent is idempotent, so redelivery is safe.
  await applyDeliveryEvent(parsed.raw);
  // Type and id only — recipients are addresses and stay out of the logs.
  info(LOG_LABEL, 'SES event received', {
    eventType: parsed.eventType,
    sesMessageId: parsed.sesMessageId,
    recorded,
  });

  // sqs-consumer deletes a message only when its handler returns it. Resolving
  // with nothing leaves the message on the queue, where it is redelivered and
  // dead-lettered after five receives even though it was stored (KAN-329).
  // Failures throw above, so they are never acknowledged.
  return message;
}

/**
 * Start polling, or do nothing at all. Returns the consumer, or null when the
 * queue is not configured — the caller does not branch on which.
 */
export function startEmailEventsWorker() {
  if (!isEmailEventsConfigured()) {
    info(LOG_LABEL, 'SES events queue not configured; event consumer not started');
    return null;
  }

  const consumer = Consumer.create({
    queueUrl: envValue('SES_EVENTS_QUEUE_URL'),
    sqs: new SQSClient({
      region: envValue('AWS_REGION'),
      credentials: {
        accessKeyId: envValue('AWS_ACCESS_KEY_ID'),
        secretAccessKey: envValue('AWS_SECRET_ACCESS_KEY'),
      },
    }),
    ...EMAIL_EVENTS_POLLING,
    handleMessage: handleEmailEventMessage,
  });

  // 'error' is the poll/connection failing (bad queue URL, revoked key);
  // 'processing_error' is handleEmailEventMessage throwing. Both are logged,
  // neither kills the process — the message outlives the failure either way.
  consumer.on('error', (err) => error(LOG_LABEL, 'SQS consumer error', { error: err.message }));
  consumer.on('timeout_error', (err) => error(LOG_LABEL, 'SES event handler exceeded its time budget', {
    error: err.message,
  }));

  // The circuit breaker: a handler bug that throws on EVERY message would
  // otherwise march the whole queue into the DLQ, five failures at a time.
  // Stopping keeps the messages on the main queue and trips the stalled-queue
  // alarm, which is the intended way for a human to find out.
  let consecutiveFailures = 0;
  consumer.on('processing_error', (err) => {
    error(LOG_LABEL, 'SES event processing failed; message returns to the queue', { error: err.message });
    consecutiveFailures += 1;
    if (consecutiveFailures >= EMAIL_EVENTS_FAILURE_LIMIT) {
      error(LOG_LABEL, `${consecutiveFailures} consecutive failures; stopping the consumer so messages stay on the main queue`, {});
      consumer.stop();
    }
  });
  consumer.on('message_processed', () => {
    consecutiveFailures = 0;
  });

  // Finish the in-flight batch instead of dying mid-write; SQS redelivers
  // whatever was not completed either way.
  process.on('SIGTERM', () => consumer.stop());

  consumer.start();
  info(LOG_LABEL, 'SES events consumer started');
  return consumer;
}
