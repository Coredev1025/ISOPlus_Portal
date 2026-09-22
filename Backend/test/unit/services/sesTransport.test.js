// Backend/test/unit/services/sesTransport.test.js
//
// The online half of the delivery seam (Epic 5 part 4). Sending is the AWS SDK
// (SESv2), not SMTP — no SMTP credential exists for this account. Nothing in
// this file may open a socket: nodemailer and the SES client are mocked
// wholesale, so every assertion is about what WOULD have gone to SES.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn() },
}));

vi.mock('@aws-sdk/client-sesv2', () => {
  class SESv2Client {
    constructor(config) {
      this.config = config;
    }
  }
  class SendEmailCommand {}
  return { SESv2Client, SendEmailCommand };
});

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), error: vi.fn(), warn: vi.fn() };
});

const nodemailer = (await import('nodemailer')).default;
const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
const { info, error } = await import('../../../src/utils/logger.js');
const {
  isEmailTransportConfigured,
  emailTransportConfig,
  isAccessDeniedError,
  sendEmail,
  resetEmailTransport,
} = await import('../../../src/services/email/sesTransport.js');

const SECRET = 'NotARealAwsSecretAccessKey1234567890abcd';
const CONFIG_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'EMAIL_FROM'];

/** Every argument every logger mock was called with, flattened to one string. */
function allLoggedText() {
  return [...info.mock.calls, ...error.mock.calls]
    .map((args) => args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(' '))
    .join('\n');
}

describe('sesTransport', () => {
  const saved = {};
  let sendMail;

  beforeEach(() => {
    for (const key of CONFIG_KEYS) {
      saved[key] = process.env[key];
    }
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLEACCESSKEY';
    process.env.AWS_SECRET_ACCESS_KEY = SECRET;
    process.env.AWS_REGION = 'ap-southeast-2';
    process.env.EMAIL_FROM = 'noreply@dev.isoplus.online';

    vi.clearAllMocks();
    resetEmailTransport();
    sendMail = vi.fn().mockResolvedValue({
      messageId: '<abc@ap-southeast-2.amazonses.com>',
      envelope: { from: 'noreply@dev.isoplus.online', to: ['client@example.com'] },
      response: 'abc',
    });
    nodemailer.createTransport.mockReturnValue({ sendMail });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEmailTransport();
  });

  describe('isEmailTransportConfigured', () => {
    it('is true only when the AWS credential, region and default From are all present', () => {
      expect(isEmailTransportConfigured()).toBe(true);
    });

    it.each(CONFIG_KEYS)('reads as NOT configured when %s is missing', (key) => {
      delete process.env[key];
      expect(isEmailTransportConfigured()).toBe(false);
    });

    it.each(CONFIG_KEYS)('reads as NOT configured when %s is blank', (key) => {
      process.env[key] = '   ';
      expect(isEmailTransportConfigured()).toBe(false);
    });
  });

  describe('emailTransportConfig', () => {
    it('reports region and default From for diagnostics but never the secret key', () => {
      const config = emailTransportConfig();
      expect(config).toEqual({
        region: 'ap-southeast-2',
        from: 'noreply@dev.isoplus.online',
        configured: true,
      });
      expect(JSON.stringify(config)).not.toContain(SECRET);
    });
  });

  describe('isAccessDeniedError', () => {
    it('recognises the SDK access-denied shapes', () => {
      expect(isAccessDeniedError(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }))).toBe(true);
      expect(isAccessDeniedError(Object.assign(new Error('denied'), { name: 'AccessDenied' }))).toBe(true);
      expect(isAccessDeniedError(Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } }))).toBe(true);
    });

    it('does not classify ordinary failures as access denied', () => {
      expect(isAccessDeniedError(new Error('Throttling'))).toBe(false);
      expect(isAccessDeniedError(undefined)).toBe(false);
    });
  });

  describe('sendEmail', () => {
    const MESSAGE = {
      from: 'accounts@dev.isoplus.online',
      to: 'client@example.com',
      subject: 'Your invoice',
      text: 'Please find your invoice attached.',
    };

    it('builds a nodemailer SES transport over the SESv2 SDK client, not SMTP', async () => {
      await sendEmail(MESSAGE);

      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
      const [options] = nodemailer.createTransport.mock.calls[0];
      expect(options.SES.SendEmailCommand).toBe(SendEmailCommand);
      expect(options.SES.sesClient).toBeInstanceOf(SESv2Client);
      expect(options.SES.sesClient.config).toEqual({
        region: 'ap-southeast-2',
        credentials: {
          accessKeyId: 'AKIAEXAMPLEACCESSKEY',
          secretAccessKey: SECRET,
        },
      });
    });

    it('memoises the transport across sends and rebuilds it after a reset', async () => {
      await sendEmail(MESSAGE);
      await sendEmail(MESSAGE);
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);

      resetEmailTransport();
      await sendEmail(MESSAGE);
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(2);
    });

    it('falls back to EMAIL_FROM when the message has no From of its own', async () => {
      await sendEmail({ ...MESSAGE, from: undefined });
      expect(sendMail.mock.calls[0][0].from).toBe('noreply@dev.isoplus.online');
    });

    it('keeps an explicit From when the settings block provides one', async () => {
      await sendEmail(MESSAGE);
      expect(sendMail.mock.calls[0][0].from).toBe('accounts@dev.isoplus.online');
    });

    it('normalises a string recipient to an array', async () => {
      await sendEmail(MESSAGE);
      expect(sendMail.mock.calls[0][0].to).toEqual(['client@example.com']);
    });

    it('keeps an array recipient, dropping blank entries', async () => {
      await sendEmail({ ...MESSAGE, to: ['a@example.com', '  ', 'b@example.com'] });
      expect(sendMail.mock.calls[0][0].to).toEqual(['a@example.com', 'b@example.com']);
    });

    it('throws rather than sending a message to nobody', async () => {
      await expect(sendEmail({ ...MESSAGE, to: [] })).rejects.toThrow(/recipient/i);
      await expect(sendEmail({ ...MESSAGE, to: undefined })).rejects.toThrow(/recipient/i);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('refuses to send when the transport is not configured', async () => {
      delete process.env.EMAIL_FROM;
      await expect(sendEmail({ ...MESSAGE, from: undefined })).rejects.toThrow(/not configured/i);
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('refuses to send when the AWS credential is missing, whatever the From', async () => {
      delete process.env.AWS_SECRET_ACCESS_KEY;
      await expect(sendEmail(MESSAGE)).rejects.toThrow(/not configured/i);
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    // The gate that let generation proceed is isEmailTransportConfigured({ from }),
    // so the gate that lets the send proceed has to ask the same question. Asking
    // it without the From burned the invoice number and then refused to deliver.
    it('sends when the message carries its own From and EMAIL_FROM is unset', async () => {
      delete process.env.EMAIL_FROM;
      await sendEmail({ ...MESSAGE, from: 'billing@dev.isoplus.online' });
      expect(sendMail.mock.calls[0][0].from).toBe('billing@dev.isoplus.online');
    });

    it('passes cc, replyTo, html and attachments straight through', async () => {
      const attachments = [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4') }];
      await sendEmail({
        ...MESSAGE,
        cc: 'copy@example.com',
        replyTo: 'billing@dev.isoplus.online',
        html: '<p>Please find your invoice attached.</p>',
        attachments,
      });

      const sent = sendMail.mock.calls[0][0];
      expect(sent.cc).toEqual(['copy@example.com']);
      expect(sent.replyTo).toBe('billing@dev.isoplus.online');
      expect(sent.html).toBe('<p>Please find your invoice attached.</p>');
      expect(sent.attachments).toBe(attachments);
    });

    it('resolves to the BARE SES message id — the key every queue event carries', async () => {
      // nodemailer decorates the id as '<id@region.amazonses.com>'; the events
      // arriving from SQS carry the bare id. Returning the bare form here is
      // what lets an EmailEvent row join back to the send that caused it.
      sendMail.mockResolvedValueOnce({
        messageId: '<id-1@ap-southeast-2.amazonses.com>',
        envelope: { from: 'noreply@dev.isoplus.online', to: ['a@example.com', 'b@example.com'] },
        response: 'id-1',
      });

      await expect(sendEmail({ ...MESSAGE, to: ['a@example.com', 'b@example.com'] })).resolves.toEqual({
        messageId: 'id-1',
        accepted: ['a@example.com', 'b@example.com'],
        rejected: [],
      });
    });

    it('logs one success line with counts, and never the secret, recipients or body', async () => {
      await sendEmail({
        ...MESSAGE,
        attachments: [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4') }],
      });

      expect(info).toHaveBeenCalledTimes(1);
      const [, , meta] = info.mock.calls[0];
      expect(meta).toEqual(expect.objectContaining({
        messageId: 'abc',
        recipientCount: 1,
        attachmentCount: 1,
      }));

      const logged = allLoggedText();
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain('client@example.com');
      expect(logged).not.toContain('Please find your invoice attached.');
    });

    it('rejects and logs when the send fails, without leaking the secret', async () => {
      sendMail.mockRejectedValueOnce(new Error('Email address is not verified'));

      await expect(sendEmail(MESSAGE)).rejects.toThrow('Email address is not verified');
      expect(error).toHaveBeenCalledTimes(1);
      expect(allLoggedText()).not.toContain(SECRET);
    });

    /**
     * KAN-266. The message alone does not identify the call. The AWS error
     * name, HTTP status and request id are what let a failure be settled
     * against CloudTrail instead of guessed at from prose — and none of them
     * is an address, so the deliberate no-addresses rule below still holds.
     */
    it('records the AWS error name, status and request id', async () => {
      sendMail.mockRejectedValueOnce(Object.assign(
        new Error('not authorized to perform ses:SendEmail'),
        {
          name: 'AccessDeniedException',
          $fault: 'client',
          $metadata: { httpStatusCode: 403, requestId: 'aws-req-91ab' },
        },
      ));

      await expect(sendEmail(MESSAGE)).rejects.toThrow(/not authorized/);

      const [, , context] = error.mock.calls[0];
      expect(context).toMatchObject({
        errorName: 'AccessDeniedException',
        httpStatusCode: 403,
        awsRequestId: 'aws-req-91ab',
      });
      // The privacy rule this log was written under is unchanged.
      const logged = allLoggedText();
      expect(logged).not.toContain('client@example.com');
      expect(logged).not.toContain(SECRET);
    });
  });
});

describe('isEmailTransportConfigured with a settings-provided From', () => {
  // A workspace that has filled in Email From has named its sending identity.
  // Requiring EMAIL_FROM as well refused to send an email whose sender was
  // already known — which is how a fully configured workspace could sit unable
  // to deliver on an environment that simply had no default.
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'key';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.AWS_REGION = 'ap-southeast-2';
    delete process.env.EMAIL_FROM;
  });

  it('is configured when the settings supply a From and EMAIL_FROM is unset', () => {
    expect(isEmailTransportConfigured({ from: 'billing@dev.isoplus.online' })).toBe(true);
  });

  it('is still not configured when neither is set', () => {
    expect(isEmailTransportConfigured({ from: null })).toBe(false);
    expect(isEmailTransportConfigured()).toBe(false);
  });

  it('treats a blank settings From as absent, not as a sender', () => {
    expect(isEmailTransportConfigured({ from: '   ' })).toBe(false);
  });

  it('still requires the AWS credential — a From alone is not enough', () => {
    delete process.env.AWS_SECRET_ACCESS_KEY;
    expect(isEmailTransportConfigured({ from: 'billing@dev.isoplus.online' })).toBe(false);
  });

  it('falls back to EMAIL_FROM when the settings supply none', () => {
    process.env.EMAIL_FROM = 'no-reply@dev.isoplus.online';
    expect(isEmailTransportConfigured()).toBe(true);
  });
});
