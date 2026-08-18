// Backend/test/unit/services/sesTransport.test.js
//
// The online half of the delivery seam (Epic 5 part 4). Nothing in this file may
// open a socket: nodemailer is mocked wholesale, so `createTransport` and
// `sendMail` are assertions about what WOULD have gone to SES, never a send.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn() },
}));

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, info: vi.fn(), error: vi.fn(), warn: vi.fn() };
});

const nodemailer = (await import('nodemailer')).default;
const { info, error } = await import('../../../src/utils/logger.js');
const {
  isEmailTransportConfigured,
  emailTransportConfig,
  sendEmail,
  resetEmailTransport,
} = await import('../../../src/services/email/sesTransport.js');

const PASSWORD = 'BNotARealSesSmtpSecret1234567890';

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
    for (const key of ['SES_SMTP_HOST', 'SES_SMTP_PORT', 'SES_SMTP_USER', 'SES_SMTP_PASSWORD']) {
      saved[key] = process.env[key];
    }
    process.env.SES_SMTP_HOST = 'email-smtp.ap-southeast-2.amazonaws.com';
    process.env.SES_SMTP_PORT = '587';
    process.env.SES_SMTP_USER = 'AKIAEXAMPLESMTPUSER';
    process.env.SES_SMTP_PASSWORD = PASSWORD;

    vi.clearAllMocks();
    resetEmailTransport();
    sendMail = vi.fn().mockResolvedValue({
      messageId: '<abc@example.com>',
      accepted: ['client@example.com'],
      rejected: [],
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
    it('is true only when host, user and password are all present', () => {
      expect(isEmailTransportConfigured()).toBe(true);
    });

    it.each(['SES_SMTP_HOST', 'SES_SMTP_USER', 'SES_SMTP_PASSWORD'])(
      'reads as NOT configured when %s is missing', (key) => {
        delete process.env[key];
        expect(isEmailTransportConfigured()).toBe(false);
      },
    );

    it.each(['SES_SMTP_HOST', 'SES_SMTP_USER', 'SES_SMTP_PASSWORD'])(
      'reads as NOT configured when %s is blank', (key) => {
        process.env[key] = '   ';
        expect(isEmailTransportConfigured()).toBe(false);
      },
    );
  });

  describe('emailTransportConfig', () => {
    it('reports host, port and user for diagnostics but never the password', () => {
      const config = emailTransportConfig();
      expect(config).toEqual({
        host: 'email-smtp.ap-southeast-2.amazonaws.com',
        port: 587,
        user: 'AKIAEXAMPLESMTPUSER',
        configured: true,
      });
      expect(JSON.stringify(config)).not.toContain(PASSWORD);
    });
  });

  describe('sendEmail', () => {
    const MESSAGE = {
      from: 'accounts@iso-plus.com.au',
      to: 'client@example.com',
      subject: 'Your invoice',
      text: 'Please find your invoice attached.',
    };

    it('builds a STARTTLS transport for the 587 SES endpoint and passes the credential', async () => {
      await sendEmail(MESSAGE);

      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
      expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
        host: 'email-smtp.ap-southeast-2.amazonaws.com',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: 'AKIAEXAMPLESMTPUSER', pass: PASSWORD },
      }));
    });

    it('memoises the transport across sends and rebuilds it after a reset', async () => {
      await sendEmail(MESSAGE);
      await sendEmail(MESSAGE);
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);

      resetEmailTransport();
      await sendEmail(MESSAGE);
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(2);
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
      delete process.env.SES_SMTP_PASSWORD;
      await expect(sendEmail(MESSAGE)).rejects.toThrow(/not configured/i);
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('passes cc, replyTo, html and attachments straight through', async () => {
      const attachments = [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4') }];
      await sendEmail({
        ...MESSAGE,
        cc: 'copy@example.com',
        replyTo: 'billing@iso-plus.com.au',
        html: '<p>Please find your invoice attached.</p>',
        attachments,
      });

      const sent = sendMail.mock.calls[0][0];
      expect(sent.cc).toEqual(['copy@example.com']);
      expect(sent.replyTo).toBe('billing@iso-plus.com.au');
      expect(sent.html).toBe('<p>Please find your invoice attached.</p>');
      expect(sent.attachments).toBe(attachments);
    });

    it('resolves to the message id and the accepted/rejected split', async () => {
      sendMail.mockResolvedValueOnce({
        messageId: '<id-1@ses>',
        accepted: ['a@example.com'],
        rejected: ['b@example.com'],
      });

      await expect(sendEmail({ ...MESSAGE, to: ['a@example.com', 'b@example.com'] })).resolves.toEqual({
        messageId: '<id-1@ses>',
        accepted: ['a@example.com'],
        rejected: ['b@example.com'],
      });
    });

    it('logs one success line with counts, and never the credential, recipients or body', async () => {
      await sendEmail({
        ...MESSAGE,
        attachments: [{ filename: 'invoice.pdf', content: Buffer.from('%PDF-1.4') }],
      });

      expect(info).toHaveBeenCalledTimes(1);
      const [, , meta] = info.mock.calls[0];
      expect(meta).toEqual(expect.objectContaining({
        messageId: '<abc@example.com>',
        recipientCount: 1,
        attachmentCount: 1,
      }));

      const logged = allLoggedText();
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain('client@example.com');
      expect(logged).not.toContain('Please find your invoice attached.');
    });

    it('rejects and logs when the transport fails, without leaking the credential', async () => {
      sendMail.mockRejectedValueOnce(new Error('535 Authentication Credentials Invalid'));

      await expect(sendEmail(MESSAGE)).rejects.toThrow('535 Authentication Credentials Invalid');
      expect(error).toHaveBeenCalledTimes(1);
      expect(allLoggedText()).not.toContain(PASSWORD);
    });
  });
});
