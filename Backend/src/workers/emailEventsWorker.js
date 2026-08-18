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

import { parseSesEventMessage, recordEmailEvent } from '../services/email/events.js';
import { info, error } from '../utils/logger.js';

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
  const { recorded } = await recordEmailEvent(parsed);
  // Type and id only — recipients are addresses and stay out of the logs.
  info(LOG_LABEL, 'SES event received', {
    eventType: parsed.eventType,
    sesMessageId: parsed.sesMessageId,
    recorded,
  });
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
    handleMessage: handleEmailEventMessage,
  });

  // 'error' is the poll/connection failing (bad queue URL, revoked key);
  // 'processing_error' is handleEmailEventMessage throwing. Both are logged,
  // neither kills the process — the message outlives the failure either way.
  consumer.on('error', (err) => error(LOG_LABEL, 'SQS consumer error', { error: err.message }));
  consumer.on('processing_error', (err) => error(LOG_LABEL, 'SES event processing failed; message returns to the queue', {
    error: err.message,
  }));

  consumer.start();
  info(LOG_LABEL, 'SES events consumer started');
  return consumer;
}
