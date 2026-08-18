// Backend/test/unit/workers/emailEventsWorker.test.js
//
// The SQS poller for SES delivery events. Inert by design when the queue URL
// is not configured — an environment without the queue must boot and run
// exactly as before. sqs-consumer is mocked: these tests assert the wiring,
// not Amazon's long polling.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const consumerInstance = { start: vi.fn(), on: vi.fn() };

vi.mock('sqs-consumer', () => ({
  Consumer: { create: vi.fn(() => consumerInstance) },
}));

vi.mock('@aws-sdk/client-sqs', () => {
  class SQSClient {
    constructor(config) {
      this.config = config;
    }
  }
  return { SQSClient };
});

const { Consumer } = await import('sqs-consumer');
const EmailEvent = (await import('../../../src/models/EmailEvent.js')).default;
const {
  isEmailEventsConfigured,
  startEmailEventsWorker,
  handleEmailEventMessage,
} = await import('../../../src/workers/emailEventsWorker.js');

const ENV_KEYS = ['SES_EVENTS_QUEUE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'];
const QUEUE_URL = 'https://sqs.ap-southeast-2.amazonaws.com/000000000000/test-ses-events';

const DELIVERY_BODY = JSON.stringify({
  eventType: 'Delivery',
  mail: {
    timestamp: '2026-08-18T02:00:00.000Z',
    messageId: 'delivery-message-id',
    destination: ['success@simulator.amazonses.com'],
  },
  delivery: { timestamp: '2026-08-18T02:00:03.000Z' },
});

describe('emailEventsWorker', () => {
  const saved = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.SES_EVENTS_QUEUE_URL = QUEUE_URL;
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLEACCESSKEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'NotARealAwsSecretAccessKey1234567890abcd';
    process.env.AWS_REGION = 'ap-southeast-2';
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('isEmailEventsConfigured', () => {
    it('is true only when the queue URL, credential and region are all present', () => {
      expect(isEmailEventsConfigured()).toBe(true);
    });

    it.each(ENV_KEYS)('reads as NOT configured when %s is missing', (key) => {
      delete process.env[key];
      expect(isEmailEventsConfigured()).toBe(false);
    });
  });

  describe('startEmailEventsWorker', () => {
    it('is inert when the queue is not configured', () => {
      delete process.env.SES_EVENTS_QUEUE_URL;

      expect(startEmailEventsWorker()).toBeNull();
      expect(Consumer.create).not.toHaveBeenCalled();
    });

    it('polls the configured queue and starts', () => {
      const worker = startEmailEventsWorker();

      expect(worker).toBe(consumerInstance);
      expect(consumerInstance.start).toHaveBeenCalledTimes(1);
      const [options] = Consumer.create.mock.calls[0];
      expect(options.queueUrl).toBe(QUEUE_URL);
      expect(options.sqs.config).toEqual({
        region: 'ap-southeast-2',
        credentials: {
          accessKeyId: 'AKIAEXAMPLEACCESSKEY',
          secretAccessKey: 'NotARealAwsSecretAccessKey1234567890abcd',
        },
      });
      expect(typeof options.handleMessage).toBe('function');
    });

    it('listens for consumer errors so a poll failure cannot kill the process silently', () => {
      startEmailEventsWorker();

      const listened = consumerInstance.on.mock.calls.map(([event]) => event);
      expect(listened).toEqual(expect.arrayContaining(['error', 'processing_error']));
    });
  });

  describe('handleEmailEventMessage', () => {
    beforeEach(async () => {
      await EmailEvent.deleteMany({});
    });

    it('records the parsed event', async () => {
      await handleEmailEventMessage({ Body: DELIVERY_BODY });

      const rows = await EmailEvent.find({}).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ eventType: 'Delivery', sesMessageId: 'delivery-message-id' });
    });

    it('lets a malformed body throw, so SQS redelivers instead of deleting the event', async () => {
      await expect(handleEmailEventMessage({ Body: 'not json' })).rejects.toThrow();
      expect(await EmailEvent.countDocuments({})).toBe(0);
    });
  });
});
