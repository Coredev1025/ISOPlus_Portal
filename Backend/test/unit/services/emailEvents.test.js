// Backend/test/unit/services/emailEvents.test.js
//
// SES delivery/bounce events arrive from an SQS queue the app polls. Parsing
// and recording are separated so each is testable without the other: parse
// turns a queue message body into one normalised record, record writes it
// idempotently — SQS is at-least-once, so the same event WILL arrive twice.
import { describe, it, expect, beforeEach } from 'vitest';

import EmailEvent from '../../../src/models/EmailEvent.js';
import { parseSesEventMessage, recordEmailEvent } from '../../../src/services/email/events.js';

const BOUNCE_EVENT = {
  eventType: 'Bounce',
  mail: {
    timestamp: '2026-08-18T02:00:00.000Z',
    messageId: '0100018f-example-message-id',
    source: 'noreply@dev.isoplus.online',
    destination: ['bounce@simulator.amazonses.com'],
    commonHeaders: { subject: 'Your ISO+ invoice run' },
  },
  bounce: {
    bounceType: 'Permanent',
    bounceSubType: 'General',
    timestamp: '2026-08-18T02:00:05.000Z',
    bouncedRecipients: [{ emailAddress: 'bounce@simulator.amazonses.com' }],
  },
};

describe('parseSesEventMessage', () => {
  it('normalises a raw SES event body', () => {
    const parsed = parseSesEventMessage(JSON.stringify(BOUNCE_EVENT));

    expect(parsed).toMatchObject({
      eventType: 'Bounce',
      sesMessageId: '0100018f-example-message-id',
      recipients: ['bounce@simulator.amazonses.com'],
      subject: 'Your ISO+ invoice run',
    });
    expect(parsed.detail).toMatchObject({ bounceType: 'Permanent', bounceSubType: 'General' });
  });

  it('unwraps an SNS notification envelope when the subscription is not raw', () => {
    const wrapped = JSON.stringify({
      Type: 'Notification',
      MessageId: 'sns-envelope-id',
      Message: JSON.stringify(BOUNCE_EVENT),
    });

    expect(parseSesEventMessage(wrapped)).toMatchObject({
      eventType: 'Bounce',
      sesMessageId: '0100018f-example-message-id',
    });
  });

  it('takes the event time from the type-specific block, falling back to the mail timestamp', () => {
    const parsed = parseSesEventMessage(JSON.stringify(BOUNCE_EVENT));
    expect(parsed.eventAt.toISOString()).toBe('2026-08-18T02:00:05.000Z');

    const { bounce, ...noBlockTimestamp } = BOUNCE_EVENT;
    const fallback = parseSesEventMessage(JSON.stringify({
      ...noBlockTimestamp,
      bounce: { ...bounce, timestamp: undefined },
    }));
    expect(fallback.eventAt.toISOString()).toBe('2026-08-18T02:00:00.000Z');
  });

  it('throws on a body that is not JSON, so the message returns to the queue', () => {
    expect(() => parseSesEventMessage('not json')).toThrow();
  });

  it('throws when the event type or message id is missing, rather than storing an unkeyable row', () => {
    expect(() => parseSesEventMessage(JSON.stringify({ mail: { messageId: 'x' } }))).toThrow(/eventType/i);
    expect(() => parseSesEventMessage(JSON.stringify({ eventType: 'Delivery', mail: {} }))).toThrow(/messageId/i);
  });
});

describe('recordEmailEvent', () => {
  beforeEach(async () => {
    await EmailEvent.deleteMany({});
  });

  function parsedBounce() {
    return parseSesEventMessage(JSON.stringify(BOUNCE_EVENT));
  }

  it('stores one row per event', async () => {
    const result = await recordEmailEvent(parsedBounce());

    expect(result.recorded).toBe(true);
    const rows = await EmailEvent.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'Bounce',
      sesMessageId: '0100018f-example-message-id',
      recipients: ['bounce@simulator.amazonses.com'],
    });
  });

  it('absorbs an SQS redelivery of the same event without a second row', async () => {
    await recordEmailEvent(parsedBounce());
    const second = await recordEmailEvent(parsedBounce());

    expect(second.recorded).toBe(false);
    expect(await EmailEvent.countDocuments({})).toBe(1);
  });

  it('keeps distinct event types for the same message as separate rows', async () => {
    await recordEmailEvent(parsedBounce());
    await recordEmailEvent(parseSesEventMessage(JSON.stringify({
      ...BOUNCE_EVENT,
      eventType: 'Delivery',
      bounce: undefined,
      delivery: { timestamp: '2026-08-18T02:00:04.000Z', recipients: ['bounce@simulator.amazonses.com'] },
    })));

    expect(await EmailEvent.countDocuments({})).toBe(2);
  });
});
