// The online half of the delivery seam. outbox.js writes a composed message to
// a file when offline; this module hands the same message to AWS SES over SMTP.
//
// Two deliberate constraints:
//   * The transporter is built on first send, not at import. Reading env at
//     module load races dotenv and freezes whatever the process happened to have
//     — the same ordering bug the auth notes in CLAUDE.md call out.
//   * A half-configured environment reads as NOT configured. The caller uses
//     isEmailTransportConfigured() to decide whether to generate invoices at
//     all, and those claim real invoice numbers off Business.documentNumbering.
//     "Probably sendable" is not good enough to burn one.

import nodemailer from 'nodemailer';
import { info, error } from '../../utils/logger.js';

const DEFAULT_SMTP_PORT = 587;
const IMPLICIT_TLS_PORT = 465;

let transporter = null;

/** Trimmed env value, or '' for unset/blank — blank and absent mean the same here. */
function envValue(name) {
  return String(process.env[name] ?? '').trim();
}

function smtpPort() {
  const parsed = Number.parseInt(envValue('SES_SMTP_PORT'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SMTP_PORT;
}

/**
 * True only when host, user AND password are all present. Any one missing means
 * delivery is off, rather than half on.
 */
export function isEmailTransportConfigured() {
  return Boolean(envValue('SES_SMTP_HOST') && envValue('SES_SMTP_USER') && envValue('SES_SMTP_PASSWORD'));
}

/**
 * The transport settings, safe to log — host, port and user only. The password
 * is never part of this shape, so a diagnostic line cannot leak it by accident.
 */
export function emailTransportConfig() {
  return {
    host: envValue('SES_SMTP_HOST') || null,
    port: smtpPort(),
    user: envValue('SES_SMTP_USER') || null,
    configured: isEmailTransportConfigured(),
  };
}

/** Drop the memoised transporter — for tests, and for a credential rotation. */
export function resetEmailTransport() {
  transporter = null;
}

/**
 * Port 587 is STARTTLS: the connection opens in the clear and is upgraded.
 * `requireTLS` makes that upgrade mandatory, so a server that will not negotiate
 * TLS fails the send instead of receiving the credential in plaintext.
 */
function buildTransport() {
  const port = smtpPort();
  return nodemailer.createTransport({
    host: envValue('SES_SMTP_HOST'),
    port,
    secure: port === IMPLICIT_TLS_PORT,
    requireTLS: true,
    auth: { user: envValue('SES_SMTP_USER'), pass: envValue('SES_SMTP_PASSWORD') },
  });
}

function getTransport() {
  transporter ??= buildTransport();
  return transporter;
}

/** A string, an array or nothing, reduced to a list of non-blank addresses. */
function toAddressList(value) {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Send one composed message through SES.
 *
 * @param {object} message
 * @param {string} message.from
 * @param {string|string[]} message.to
 * @param {string|string[]} [message.cc]
 * @param {string} [message.replyTo]
 * @param {string} [message.subject]
 * @param {string} [message.html]
 * @param {string} [message.text]
 * @param {Array<{filename: string, content: Buffer}>} [message.attachments]
 * @returns {Promise<{messageId: string, accepted: string[], rejected: string[]}>}
 */
export async function sendEmail({ from, to, cc, replyTo, subject, html, text, attachments = [] }) {
  const recipients = toAddressList(to);
  if (recipients.length === 0) {
    throw new Error('sendEmail requires at least one recipient — refusing to send a message to nobody.');
  }
  if (!isEmailTransportConfigured()) {
    throw new Error(
      'Email transport is not configured: SES_SMTP_HOST, SES_SMTP_USER and SES_SMTP_PASSWORD must all be set.',
    );
  }

  const envelope = {
    from,
    to: recipients,
    cc: toAddressList(cc),
    replyTo,
    subject,
    html,
    text,
    attachments,
  };

  try {
    const result = await getTransport().sendMail(envelope);
    info('SES-Transport', 'Email sent', {
      messageId: result?.messageId ?? null,
      recipientCount: recipients.length,
      acceptedCount: toAddressList(result?.accepted).length,
      rejectedCount: toAddressList(result?.rejected).length,
      attachmentCount: attachments.length,
    });
    return {
      messageId: result?.messageId ?? null,
      accepted: result?.accepted ?? [],
      rejected: result?.rejected ?? [],
    };
  } catch (err) {
    // Host and recipient COUNT only: no addresses, no body, no credential.
    error('SES-Transport', 'Email send failed', {
      message: err?.message,
      host: envValue('SES_SMTP_HOST'),
      recipientCount: recipients.length,
      attachmentCount: attachments.length,
    });
    throw err;
  }
}
