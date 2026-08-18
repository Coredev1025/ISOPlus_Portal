// Backend/test/unit/workers/emailEventsWorker.test.js
//
// The SQS poller for SES delivery events. Inert by design when the queue URL
// is not configured — an environment without the queue must boot and run
// exactly as before. sqs-consumer is mocked: these tests assert the wiring,
// not Amazon's long polling.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const consumerInstance = { start: vi.fn(), stop: vi.fn(), on: vi.fn() };

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

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

const { Consumer } = await import('sqs-consumer');
const { warn, error } = await import('../../../src/utils/logger.js');
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

    it('long-polls in batches with a heartbeat, per the queue owner’s tuning', () => {
      startEmailEventsWorker();

      const [options] = Consumer.create.mock.calls[0];
      expect(options).toMatchObject({
        batchSize: 10,
        waitTimeSeconds: 20,
        visibilityTimeout: 30,
        heartbeatInterval: 10,
      });
    });

    it('listens for consumer errors so a poll failure cannot kill the process silently', () => {
      startEmailEventsWorker();

      const listened = consumerInstance.on.mock.calls.map(([event]) => event);
      expect(listened).toEqual(expect.arrayContaining(['error', 'processing_error', 'timeout_error']));
    });

    it('stops itself after 10 consecutive processing failures, keeping messages on the main queue', () => {
      // A handler bug that throws on EVERY message would otherwise march the
      // whole queue into the DLQ, five failures at a time. Stopped, the
      // messages wait on the main queue while someone investigates.
      startEmailEventsWorker();
      const handlers = Object.fromEntries(consumerInstance.on.mock.calls);

      for (let i = 0; i < 9; i += 1) handlers.processing_error(new Error('boom'));
      expect(consumerInstance.stop).not.toHaveBeenCalled();

      handlers.processing_error(new Error('boom'));
      expect(consumerInstance.stop).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/consecutive failures/i),
        expect.anything(),
      );
    });

    it('a processed message resets the failure count', () => {
      startEmailEventsWorker();
      const handlers = Object.fromEntries(consumerInstance.on.mock.calls);

      for (let i = 0; i < 9; i += 1) handlers.processing_error(new Error('boom'));
      handlers.message_processed();
      for (let i = 0; i < 9; i += 1) handlers.processing_error(new Error('boom'));

      expect(consumerInstance.stop).not.toHaveBeenCalled();
    });

    it('stops on SIGTERM so in-flight messages finish instead of being killed mid-write', () => {
      const processOn = vi.spyOn(process, 'on').mockImplementation(() => process);

      try {
        startEmailEventsWorker();
        const sigterm = processOn.mock.calls.find(([signal]) => signal === 'SIGTERM');
        expect(sigterm).toBeDefined();

        sigterm[1]();
        expect(consumerInstance.stop).toHaveBeenCalledTimes(1);
      } finally {
        processOn.mockRestore();
      }
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

    it('flags an SNS-enveloped body: raw delivery is on, so a wrapper means the infrastructure changed', async () => {
      const wrapped = JSON.stringify({ Type: 'Notification', MessageId: 'sns-id', Message: DELIVERY_BODY });

      await handleEmailEventMessage({ Body: wrapped });

      // Still recorded — losing the event would compound the problem — but
      // loudly, because RawMessageDelivery being off is an infra regression.
      expect(await EmailEvent.countDocuments({})).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/envelope|raw/i),
        expect.anything(),
      );
    });
  });
});
