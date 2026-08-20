import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

import { KIND_INVOICE, KIND_STATEMENT } from '../../src/constants/automation.js';

/**
 * End to end over the four things the review thread asked for, each through the
 * real code path rather than a unit stub:
 *
 *   1. The S3 key names the period the document covers  (Arnold)
 *   2. The email subject and body name the business and board, never a board id
 *   3. The Automation Settings WYSIWYG wins over those defaults
 *   4. bypassEmail redirects the send and never reads the participant's address
 *
 * The seams stubbed are the ones that need network — pdfme, S3, SES, and the
 * DB context the NDIS generator builds. Everything between them is the real
 * implementation, which is where all four fixes live.
 */

const uploadedKeys = [];
const sentMessages = [];

vi.mock('@pdfme/generator', () => ({
  generate: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])), // "%PDF"
}));

vi.mock('../../src/utils/uploadS3.js', () => ({
  uploadFileToS3: vi.fn(async (_buf, key) => {
    uploadedKeys.push(key);
    return { $metadata: { httpStatusCode: 200 } };
  }),
  getS3FileUrl: vi.fn(async (key) => `https://s3.example/${key}`),
  getS3File: vi.fn(async () => Buffer.from('logo')),
}));

vi.mock('../../src/services/email/sesTransport.js', () => ({
  sendEmail: vi.fn(async (message) => {
    sentMessages.push(message);
    return { messageId: '<e2e@ses>' };
  }),
  isEmailTransportConfigured: () => true,
  isAccessDeniedError: () => false,
}));

vi.mock('../../src/services/email/deliveryEvents.js', () => ({
  recordEmailSend: async () => {},
}));

const resolveRecipient = vi.fn(async () => ({
  address: 'real.billing.contact@participant.example',
  source: 'profile_billing_email',
}));
vi.mock('../../src/services/email/recipients.js', () => ({ resolveRecipient }));

const { ndisInvoicePdfFilename } = await import('../../src/utils/ndisInvoiceGeneratorPdfHelpers.js');
const { invoicePeriodSuffix } = await import('../../src/utils/invoicePeriodSuffix.js');
const { deliverEmail } = await import('../../src/services/email/outbox.js');

const TZ = 'Australia/Sydney';
// The August 2026 window, as schedulePeriodServiceDeliveryWindow produces it:
// instants whose Sydney wall-clock days are the 1st and the 31st.
const PERIOD = {
  start: '2026-07-31T14:00:00.000Z',
  end: '2026-08-31T13:59:59.999Z',
};

beforeEach(() => {
  uploadedKeys.length = 0;
  sentMessages.length = 0;
  resolveRecipient.mockClear();
});

describe('1. the document key names the period it covers', () => {
  it('embeds the period in the NDIS invoice S3 key', () => {
    const key = ndisInvoicePdfFilename(
      '55390', 'jpjztrn14pJ', 'INV-1006', 'Mike Bird', invoicePeriodSuffix(PERIOD, TZ),
    );

    // Arnold's shape.
    expect(key).toContain('INV-1006-ISO+™-Mike_Bird_2026-08-01_to_2026-08-31.pdf');
  });

  it('leaves a manual generation key byte-identical to before', () => {
    // Manual generation carries no period. Those keys are already stored on
    // PDFLink rows, so changing them would orphan every existing document.
    const key = ndisInvoicePdfFilename('55390', 'jpjztrn14pJ', 'INV-1006', 'Mike Bird', '');
    expect(key).toBe('output/55390/jpjztrn14pJ/NDIS-invoices/INV-1006-ISO+™-Mike_Bird.pdf');
  });

  it('names the period in the business timezone, not UTC', () => {
    // The window opens at 14:00Z on 31 July, which is 1 August in Sydney.
    // Naming it 2026-07-31 would misreport the billing period on the filename
    // a person reconciles against.
    expect(invoicePeriodSuffix(PERIOD, TZ)).toBe('_2026-08-01_to_2026-08-31');
  });
});

const message = (extra = {}) => ({
  kind: KIND_INVOICE,
  workspaceId: '55390',
  boardId: 'jpjztrn14pJ',
  periodKey: '20260820-1902',
  recipientKey: 'Mike Bird',
  businessName: 'ISO Consulting Services',
  boardName: 'Care Management - NDIS - Certification',
  documentNumbers: ['INV-1006 (ISO+™)'],
  block: {
    recipient: 'billing_contact',
    sendMethod: 'isoplus',
    emailSubject: '',
    emailMessage: '',
  },
  attachments: [],
  ...extra,
});

describe('2. the email names people and places, not ids', () => {
  it('sends a subject naming the document and the business', async () => {
    await deliverEmail(message());

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].subject)
      .toBe('Invoice INV-1006 (ISO+™) from ISO Consulting Services');
  });

  it('never puts the board id in the subject or the body', async () => {
    await deliverEmail(message());

    const { subject, html } = sentMessages[0];
    expect(subject).not.toContain('jpjztrn14pJ');
    expect(html).not.toContain('jpjztrn14pJ');
    // The board's NAME is what appears instead.
    expect(html).toContain('Care Management - NDIS - Certification');
  });

  it('sends a body that is no longer empty', async () => {
    await deliverEmail(message());

    const { html } = sentMessages[0];
    expect(html).toContain('Mike Bird');
    expect(html).toMatch(/attach/i);
    expect(html.length).toBeGreaterThan(100);
  });

  it('tells a statement recipient it is not a bill', async () => {
    await deliverEmail(message({
      kind: KIND_STATEMENT,
      documentNumbers: ['STM-2026-08-0001'],
    }));

    expect(sentMessages[0].subject).toMatch(/^Statement /);
    expect(sentMessages[0].html).toMatch(/not a tax invoice|no new charges/i);
  });
});

describe('3. the Automation Settings WYSIWYG wins', () => {
  it('uses the form subject and body verbatim when they are set', async () => {
    await deliverEmail(message({
      block: {
        recipient: 'billing_contact',
        sendMethod: 'isoplus',
        emailSubject: 'Your August invoice',
        emailMessage: '<p>Hi — see attached. <em>Thanks!</em></p>',
      },
    }));

    expect(sentMessages[0].subject).toBe('Your August invoice');
    expect(sentMessages[0].html).toBe('<p>Hi — see attached. <em>Thanks!</em></p>');
    // The default must not be appended to or merged with it.
    expect(sentMessages[0].html).not.toMatch(/Hello Mike Bird/);
  });
});

describe('4. bypassEmail redirects the send', () => {
  it('sends to the override and never reads the participant address', async () => {
    await deliverEmail(message({ bypassEmail: ['allanaire@isoconsultingservices.com.au'] }));

    expect(sentMessages[0].to).toBe('allanaire@isoconsultingservices.com.au');
    // The property that matters: the real billing contact was never resolved,
    // so it cannot be reached even by a later mistake in this path.
    expect(resolveRecipient).not.toHaveBeenCalled();
  });

  it('resolves the participant normally when no override is given', async () => {
    await deliverEmail(message());

    expect(resolveRecipient).toHaveBeenCalledTimes(1);
    expect(sentMessages[0].to).toBe('real.billing.contact@participant.example');
  });
});
