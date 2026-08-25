import { describe, it, expect, beforeEach } from 'vitest';

import PDFLink from '../../../src/models/PDFLink.js';
import {
  applyDeliveryEvent,
  bounceReason,
  describeSesEvent,
  normalizeMessageId,
  recordEmailFailure,
  recordEmailSend,
} from '../../../src/services/email/deliveryEvents.js';

const WS = 'ws-delivery-1';
const INVOICE_URL = 'https://files.test/inv-1.pdf';
const STATEMENT_URL = 'https://files.test/stmt-1.pdf';

/** A PDFLink row the way an automation run records one. */
function automationPdfLink(overrides = {}) {
  return PDFLink.create({
    workspaceId: WS,
    itemId: 'item-1',
    type: 'NDIS Invoice',
    pdfLink: INVOICE_URL,
    periodKey: '20250201-0900',
    ...overrides,
  });
}

/** A minimal SES event notification body. */
function sesEvent(eventType, extra = {}) {
  return {
    eventType,
    mail: {
      messageId: 'ses-native-id-1',
      commonHeaders: { messageId: '<msg-1@provider.test>' },
    },
    ...extra,
  };
}

const BOUNCE = {
  bounce: {
    bounceType: 'Permanent',
    bounceSubType: 'NoEmail',
    timestamp: '2026-08-02T00:00:00.000Z',
    bouncedRecipients: [
      { emailAddress: 'gone@example.test', diagnosticCode: 'smtp; 550 5.1.1 user unknown' },
    ],
  },
};

beforeEach(async () => {
  await PDFLink.deleteMany({});
});

describe('normalizeMessageId', () => {
  it('strips the angle brackets nodemailer returns and lowercases', () => {
    expect(normalizeMessageId('<Msg-1@Provider.Test>')).toBe('msg-1@provider.test');
    expect(normalizeMessageId('  msg-1@provider.test ')).toBe('msg-1@provider.test');
  });

  it('is null for anything that is not a usable id', () => {
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId('<>')).toBeNull();
    expect(normalizeMessageId({ nope: true })).toBeNull();
  });
});

describe('bounceReason', () => {
  it('turns the common permanent bounce into a sentence a client can act on', () => {
    expect(bounceReason({ bounceType: 'Permanent', bounceSubType: 'NoEmail' })).toBe(
      "Email address doesn't exist."
    );
  });

  it('maps a full mailbox and a suppressed address to their own sentences', () => {
    expect(bounceReason({ bounceType: 'Transient', bounceSubType: 'MailboxFull' })).toBe(
      "The recipient's mailbox is full."
    );
    expect(bounceReason({ bounceType: 'Permanent', bounceSubType: 'Suppressed' })).toBe(
      'This address bounced before, so it is on the suppression list.'
    );
  });

  it('maps the undetermined pair rather than leaving it unexplained', () => {
    expect(bounceReason({ bounceType: 'Undetermined', bounceSubType: 'Undetermined' })).toBe(
      "The email could not be delivered and the recipient's mail server did not say why."
    );
  });

  it('falls back honestly for an unknown pair, without the SMTP diagnostic', () => {
    const reason = bounceReason({
      bounceType: 'Permanent',
      bounceSubType: 'SomethingNew',
      diagnosticCode: 'smtp; 550 5.7.1 blocked by policy engine at mx.internal',
    });
    expect(reason).toBe('The email could not be delivered (Permanent/SomethingNew).');
    expect(reason).not.toMatch(/smtp|mx\.internal/i);
  });

  it('does not let a hostile bounce type leak markup into the sentence', () => {
    expect(
      bounceReason({ bounceType: '<img src=x onerror=alert(1)>', bounceSubType: 'a/b' })
    ).toBe('The email could not be delivered (imgsrcxonerroralert1/ab).');
  });
});

describe('describeSesEvent', () => {
  it('maps each event type to the state the panel shows', () => {
    expect(describeSesEvent(sesEvent('Send')).state).toBe('sent');
    expect(describeSesEvent(sesEvent('Delivery')).state).toBe('delivered');
    expect(describeSesEvent(sesEvent('Bounce', BOUNCE)).state).toBe('bounced');
    expect(describeSesEvent(sesEvent('Complaint', { complaint: {} })).state).toBe('complained');
    expect(describeSesEvent(sesEvent('Reject', { reject: { reason: 'Bad content' } })).state).toBe(
      'failed'
    );
    expect(describeSesEvent(sesEvent('DeliveryDelay', { deliveryDelay: {} })).state).toBe('delayed');
  });

  it('carries the plain-English bounce reason as the detail', () => {
    expect(describeSesEvent(sesEvent('Bounce', BOUNCE)).detail).toBe("Email address doesn't exist.");
  });

  it('accepts the older notificationType spelling SES also publishes', () => {
    const legacy = { notificationType: 'Bounce', mail: { messageId: 'x' }, ...BOUNCE };
    expect(describeSesEvent(legacy).state).toBe('bounced');
  });

  it('collects both the SES id and the Message-ID header as lookup keys', () => {
    expect(describeSesEvent(sesEvent('Delivery')).messageIds).toEqual([
      'ses-native-id-1',
      'msg-1@provider.test',
    ]);
  });

  it('is null for an unknown or missing event type', () => {
    expect(describeSesEvent(sesEvent('Open'))).toBeNull();
    expect(describeSesEvent({})).toBeNull();
    expect(describeSesEvent(null)).toBeNull();
  });
});

describe('recordEmailSend', () => {
  it('stamps the message id and the sent state on the documents the email carried', async () => {
    await automationPdfLink();
    await automationPdfLink({ itemId: 'item-2', pdfLink: STATEMENT_URL, type: 'Monthly Statement' });
    // A row from another workspace sharing the URL must not be claimed.
    await automationPdfLink({ workspaceId: 'ws-other', itemId: 'item-3' });

    const matched = await recordEmailSend({
      messageId: '<msg-1@provider.test>',
      workspaceId: WS,
      documentUrls: [INVOICE_URL, STATEMENT_URL],
    });

    expect(matched).toBe(2);
    const rows = await PDFLink.find({ workspaceId: WS }).lean();
    for (const row of rows) {
      expect(row.deliveryMessageId).toBe('msg-1@provider.test');
      expect(row.deliveryState).toBe('sent');
    }
    const other = await PDFLink.findOne({ workspaceId: 'ws-other' }).lean();
    expect(other.deliveryMessageId).toBeUndefined();
  });

  it('does nothing without a message id or without documents', async () => {
    await automationPdfLink();
    expect(await recordEmailSend({ messageId: null, workspaceId: WS, documentUrls: [INVOICE_URL] })).toBe(0);
    expect(await recordEmailSend({ messageId: '<m@x>', workspaceId: WS, documentUrls: [] })).toBe(0);
    const row = await PDFLink.findOne({ workspaceId: WS }).lean();
    expect(row.deliveryMessageId).toBeUndefined();
  });
});

/** Send, then apply one event, and read back the row's delivery fields. */
async function afterEvents(...events) {
  await automationPdfLink();
  await recordEmailSend({
    messageId: '<msg-1@provider.test>',
    workspaceId: WS,
    documentUrls: [INVOICE_URL],
  });
  const results = [];
  for (const event of events) results.push(await applyDeliveryEvent(event));
  const row = await PDFLink.findOne({ workspaceId: WS }).lean();
  return { row, results };
}

describe('applyDeliveryEvent', () => {
  it('advances a sent document to delivered', async () => {
    const { row, results } = await afterEvents(sesEvent('Delivery'));
    expect(results[0]).toMatchObject({ state: 'delivered', matched: 1 });
    expect(row.deliveryState).toBe('delivered');
    expect(row.deliveryDetail).toBeFalsy();
  });

  it('records a bounce with its plain-English reason', async () => {
    const { row } = await afterEvents(sesEvent('Bounce', BOUNCE));
    expect(row.deliveryState).toBe('bounced');
    expect(row.deliveryDetail).toBe("Email address doesn't exist.");
  });

  it('does not let a late Delivery overwrite a Bounce', async () => {
    const { row, results } = await afterEvents(sesEvent('Bounce', BOUNCE), sesEvent('Delivery'));
    expect(results[1].matched).toBe(0);
    expect(row.deliveryState).toBe('bounced');
    expect(row.deliveryDetail).toBe("Email address doesn't exist.");
  });

  it('is idempotent: the same notification twice leaves one state and one timestamp', async () => {
    const { row, results } = await afterEvents(sesEvent('Delivery'), sesEvent('Delivery'));
    expect(results[0].matched).toBe(1);
    expect(results[1].matched).toBe(0);
    expect(row.deliveryState).toBe('delivered');
  });

  it('still records a complaint after a delivery — it is the worse outcome', async () => {
    const { row } = await afterEvents(sesEvent('Delivery'), sesEvent('Complaint', { complaint: {} }));
    expect(row.deliveryState).toBe('complained');
  });

  it('matches on the SES-native id when the Message-ID header is absent', async () => {
    await automationPdfLink();
    await recordEmailSend({
      messageId: 'ses-native-id-1',
      workspaceId: WS,
      documentUrls: [INVOICE_URL],
    });
    const result = await applyDeliveryEvent({ eventType: 'Bounce', mail: { messageId: 'ses-native-id-1' }, ...BOUNCE });
    expect(result.matched).toBe(1);
  });

  it('matches nothing, and throws nothing, for an id no send ever recorded', async () => {
    const result = await applyDeliveryEvent(sesEvent('Delivery'));
    expect(result).toMatchObject({ state: 'delivered', matched: 0 });
  });

  it('ignores an event it cannot make sense of', async () => {
    expect(await applyDeliveryEvent({ eventType: 'Open', mail: { messageId: 'x' } })).toMatchObject({
      state: null,
      matched: 0,
    });
    expect(await applyDeliveryEvent(null)).toMatchObject({ state: null, matched: 0 });
  });
});

/**
 * The reproduction for the defect this closes.
 *
 * A send the backend REFUSES wrote nothing at all, so its documents stayed at
 * the default `generated` — which the status panel renders muted and
 * explicitly "never as an error". A client whose statements reached nobody was
 * shown ten neutral rows and a green "On track" badge, which is the one thing
 * Epic 5's visibility panel exists to prevent.
 *
 * Observed on portal-dev 2026-08-25: ten statements generated, zero delivered,
 * `ERROR Automation: Automation email was not delivered`, panel said Succeeded.
 */
describe('recordEmailFailure', () => {
  it('stamps "failed" and a client-readable reason on the documents that went nowhere', async () => {
    await automationPdfLink();
    await automationPdfLink({ itemId: 'item-2', pdfLink: STATEMENT_URL, type: 'Monthly Statement' });
    // Another tenant's row sharing the URL must not be claimed, exactly as for a send.
    await automationPdfLink({ workspaceId: 'ws-other', itemId: 'item-3' });

    const matched = await recordEmailFailure({
      workspaceId: WS,
      documentUrls: [INVOICE_URL, STATEMENT_URL],
      reason: 'no_address_on_profile',
    });

    expect(matched).toBe(2);

    const invoice = await PDFLink.findOne({ workspaceId: WS, pdfLink: INVOICE_URL }).lean();
    expect(invoice.deliveryState).toBe('failed');
    // Plain English, not the internal code — the client has to know what to fix.
    expect(invoice.deliveryDetail).toMatch(/no email address/i);
    expect(invoice.deliveryDetail).not.toMatch(/no_address_on_profile/);

    const other = await PDFLink.findOne({ workspaceId: 'ws-other' }).lean();
    expect(other.deliveryState ?? 'generated').toBe('generated');
  });

  it('still records a failure when the reason is one it has no sentence for', async () => {
    await automationPdfLink();

    await recordEmailFailure({
      workspaceId: WS,
      documentUrls: [INVOICE_URL],
      reason: 'something_new_from_a_later_release',
    });

    const row = await PDFLink.findOne({ workspaceId: WS, pdfLink: INVOICE_URL }).lean();
    // The state is the load-bearing part; an unmapped reason must not silently
    // drop the row back to looking healthy.
    expect(row.deliveryState).toBe('failed');
    expect(row.deliveryDetail).toBeTruthy();
  });

  /**
   * A refusal is not terminal: the documents are deliberately kept so the next
   * run hands back the same ones rather than minting new invoice numbers. When
   * that re-send succeeds the row has to stop claiming it failed.
   */
  it('is overwritten by a later successful send', async () => {
    await automationPdfLink();
    await recordEmailFailure({ workspaceId: WS, documentUrls: [INVOICE_URL], reason: 'access_denied' });

    await recordEmailSend({
      messageId: '<msg-2@provider.test>',
      workspaceId: WS,
      documentUrls: [INVOICE_URL],
    });

    const row = await PDFLink.findOne({ workspaceId: WS, pdfLink: INVOICE_URL }).lean();
    expect(row.deliveryState).toBe('sent');
    expect(row.deliveryDetail).toBeFalsy();
  });

  it('does nothing without a workspace or any documents', async () => {
    expect(await recordEmailFailure({ workspaceId: WS, documentUrls: [], reason: 'access_denied' })).toBe(0);
    expect(await recordEmailFailure({ workspaceId: '', documentUrls: [INVOICE_URL], reason: 'access_denied' })).toBe(0);
  });
});
