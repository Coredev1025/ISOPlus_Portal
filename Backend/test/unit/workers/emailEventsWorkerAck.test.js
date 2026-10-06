// Backend/test/unit/workers/emailEventsWorkerAck.test.js
//
// KAN-329. The consumer stored every SES event correctly and then never
// deleted the message: sqs-consumer deletes only when the handler RETURNS the
// message (or alwaysAcknowledge is on), and ours returned nothing. Every event
// was redelivered, reprocessed idempotently, and after five receives moved to
// the dead-letter queue.
//
// emailEventsWorker.test.js mocks sqs-consumer entirely, so it cannot see this:
// a mock does not know what the real library does with a handler's return
// value. This file runs the REAL Consumer against a fake SQS client and
// asserts on the commands it sends.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sent = [];
let receiveResponses = [];

vi.mock('@aws-sdk/client-sqs', async (importOriginal) => {
  const actual = await importOriginal();
  class SQSClient {
    constructor(config) {
      this.config = config;
    }

    async send(command) {
      sent.push(command);
      if (command instanceof actual.ReceiveMessageCommand) {
        const next = receiveResponses.shift();
        if (next) return next;
        // Nothing left: behave like long polling that came back empty.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {};
      }
      return {};
    }
  }
  return { ...actual, SQSClient };
});

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

const { DeleteMessageCommand, DeleteMessageBatchCommand } = await import('@aws-sdk/client-sqs');
const EmailEvent = (await import('../../../src/models/EmailEvent.js')).default;
const { startEmailEventsWorker } = await import('../../../src/workers/emailEventsWorker.js');

const ENV_KEYS = ['SES_EVENTS_QUEUE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'];

const DELIVERY_BODY = JSON.stringify({
  eventType: 'Delivery',
  mail: {
    timestamp: '2026-10-06T02:00:00.000Z',
    messageId: 'ack-test-message-id',
    destination: ['success@simulator.amazonses.com'],
  },
  delivery: { timestamp: '2026-10-06T02:00:03.000Z' },
});

const deletes = () => sent.filter(
  (c) => c instanceof DeleteMessageCommand || c instanceof DeleteMessageBatchCommand,
);

/** Resolves with the event's first argument, or rejects if it never fires. */
function waitForEvent(consumer, name, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`consumer never emitted "${name}"`)), timeoutMs);
    consumer.once(name, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('emailEventsWorker acknowledgement (real sqs-consumer)', () => {
  const saved = {};
  let consumer;

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.SES_EVENTS_QUEUE_URL = 'https://sqs.ap-southeast-2.amazonaws.com/000000000000/test-ses-events';
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLEACCESSKEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'NotARealAwsSecretAccessKey1234567890abcd';
    process.env.AWS_REGION = 'ap-southeast-2';
    sent.length = 0;
    receiveResponses = [];
    await EmailEvent.deleteMany({});
  });

  afterEach(() => {
    consumer?.stop();
    consumer = undefined;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('deletes a message once it has been handled successfully', async () => {
    receiveResponses = [{
      Messages: [{ MessageId: 'sqs-1', ReceiptHandle: 'receipt-1', Body: DELIVERY_BODY }],
    }];

    consumer = startEmailEventsWorker();
    // "message_processed" fires after the delete, so this waits for the real outcome.
    await waitForEvent(consumer, 'message_processed');
    consumer.stop();

    const sentDeletes = deletes();
    expect(sentDeletes).toHaveLength(1);
    expect(sentDeletes[0]).toBeInstanceOf(DeleteMessageCommand);
    expect(sentDeletes[0].input.ReceiptHandle).toBe('receipt-1');
    // Handled means stored: the delete is the acknowledgement of a real write.
    expect(await EmailEvent.countDocuments({ sesMessageId: 'ack-test-message-id' })).toBe(1);
  });

  it('does NOT delete a message whose handler failed, so it can be retried', async () => {
    receiveResponses = [{
      Messages: [{ MessageId: 'sqs-2', ReceiptHandle: 'receipt-2', Body: 'this is not JSON' }],
    }];

    consumer = startEmailEventsWorker();
    // Proves the handler ran and failed, so "no delete" is not just "nothing happened".
    await waitForEvent(consumer, 'processing_error');
    consumer.stop();

    expect(deletes()).toHaveLength(0);
    expect(await EmailEvent.countDocuments({})).toBe(0);
  });
});
