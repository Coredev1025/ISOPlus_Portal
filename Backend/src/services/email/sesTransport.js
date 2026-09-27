// The online half of the delivery seam. outbox.js writes a composed message to
// a file when offline; this module hands the same message to AWS SES through
// the SESv2 SDK. Sending is the SDK, not SMTP — no SMTP credential exists for
// this account and none is needed. nodemailer stays for what the SDK does not
// do: composing the MIME message that carries the PDF attachments.
//
// Two deliberate constraints:
//   * The transporter is built on first send, not at import. Reading env at
//     module load races dotenv and freezes whatever the process happened to have
//     — the same ordering bug the auth notes in CLAUDE.md call out.
//   * A half-configured environment reads as NOT configured. The caller uses
//     isEmailTransportConfigured() to decide whether to generate invoices at
//     all, and those claim real invoice numbers off Business.documentNumbering.
//     "Probably sendable" is not good enough to burn one.
//
// EMAIL_FROM is the deliberate opt-in: the AWS credential is shared with S3,
// so its presence alone must not turn on customer email. Only the sending
// identity's domain is verified in SES (dev.isoplus.online in dev), so an
// EMAIL_FROM on another domain will be rejected by SES — the error names the
// address.
//
// KAN-270: Email From is application-level configuration, not a
// per-workspace one. The address still varies by environment (EMAIL_FROM),
// but the display name is fixed (EMAIL_FROM_NAME) and no longer read from a
// workspace's automation settings.

import nodemailer from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { info, error } from '../../utils/logger.js';
import { EMAIL_FROM_NAME } from '../../constants/email.js';

let transporter = null;

/** Trimmed env value, or '' for unset/blank — blank and absent mean the same here. */
function envValue(name) {
  return String(process.env[name] ?? '').trim();
}

/**
 * True only when the AWS credential, region and EMAIL_FROM are all present.
 * Any one missing means delivery is off, rather than half on.
 *
 * KAN-270: Email From is application-level configuration now, so this is the
 * only sender source — there is no per-workspace override to check any more.
 */
export function isEmailTransportConfigured() {
  return Boolean(
    envValue('AWS_ACCESS_KEY_ID')
    && envValue('AWS_SECRET_ACCESS_KEY')
    && envValue('AWS_REGION')
    && envValue('EMAIL_FROM'),
  );
}

/**
 * The transport settings, safe to log — region and default From only. The
 * secret key is never part of this shape, so a diagnostic line cannot leak it
 * by accident.
 */
export function emailTransportConfig() {
  return {
    region: envValue('AWS_REGION') || null,
    from: envValue('EMAIL_FROM') || null,
    configured: isEmailTransportConfigured(),
  };
}

/**
 * An IAM refusal of the send itself. In dev this is the recipient-domain
 * guardrail on the access key doing its job — the key may only send to
 * allowlisted domains — so callers treat it as a recorded refusal rather than
 * a retryable failure: retrying can never succeed.
 */
/**
 * The provider's own account of a failure, in the fields that identify it.
 *
 * KAN-266. A message alone cannot settle why SES refused a send: the same
 * prose covers a denied sending identity and a denied recipient. The request
 * id is the handle that pulls the exact call out of CloudTrail, where the IAM
 * decision is recorded — with it a refusal is definitive rather than inferred.
 *
 * Deliberately no addresses, no body and no credential: this is metadata about
 * the call, and the callers' own privacy rules are unaffected by it.
 */
export function describeSendError(err) {
  return {
    errorName: err?.name ?? null,
    errorMessage: err?.message ?? null,
    httpStatusCode: err?.$metadata?.httpStatusCode ?? null,
    awsRequestId: err?.$metadata?.requestId ?? null,
    fault: err?.$fault ?? null,
  };
}

export function isAccessDeniedError(err) {
  return err?.name === 'AccessDeniedException'
    || err?.name === 'AccessDenied'
    || err?.$metadata?.httpStatusCode === 403;
}

/** Drop the memoised transporter — for tests, and for a credential rotation. */
export function resetEmailTransport() {
  transporter = null;
}

function buildTransport() {
  return nodemailer.createTransport({
    SES: {
      sesClient: new SESv2Client({
        region: envValue('AWS_REGION'),
        credentials: {
          accessKeyId: envValue('AWS_ACCESS_KEY_ID'),
          secretAccessKey: envValue('AWS_SECRET_ACCESS_KEY'),
        },
      }),
      SendEmailCommand,
    },
  });
}

function getTransport() {
  transporter ??= buildTransport();
  return transporter;
}

/** '<id@region.amazonses.com>' (or already-bare) → 'id'; null stays null. */
function bareMessageId(decorated) {
  if (!decorated) return null;
  return String(decorated).replace(/^</, '').replace(/>$/, '').split('@')[0] || null;
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
 * "Automated Email - DO NOT REPLY <address>" — the standard `"Name <address>"`
 * header form. nodemailer's SES transport composes a real MIME message and
 * parses this into separate display-name/address parts (mime-node ->
 * addressparser), so the name reaches the raw message it hands to SES, not
 * just a top-level SDK field.
 */
function formatFromHeader(address) {
  return `${EMAIL_FROM_NAME} <${address}>`;
}

/**
 * Send one composed message through SES.
 *
 * @param {object} message
 * @param {string} [message.from] Sending address. Defaults to EMAIL_FROM.
 *   Always sent under the fixed EMAIL_FROM_NAME display name (KAN-270).
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
      'Email transport is not configured: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, '
      + 'AWS_REGION and EMAIL_FROM must all be set.',
    );
  }

  const envelope = {
    from: formatFromHeader(from || envValue('EMAIL_FROM')),
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
    // The SES transport reports { envelope, messageId }, not the SMTP
    // accepted/rejected split — SES takes the whole message or none of it.
    // The id is returned BARE: nodemailer decorates it as
    // '<id@region.amazonses.com>', but every event on the SQS queue carries
    // the bare id, and it is the only key that joins an event to its send.
    const accepted = result?.envelope?.to ?? recipients;
    const messageId = bareMessageId(result?.messageId);
    info('SES-Transport', 'Email sent', {
      messageId,
      recipientCount: recipients.length,
      acceptedCount: accepted.length,
      attachmentCount: attachments.length,
    });
    return { messageId, accepted, rejected: [] };
  } catch (err) {
    // Region and recipient COUNT only: no addresses, no body, no credential.
    // describeSendError adds only metadata about the call — name, status,
    // request id — so that rule is unchanged.
    error('SES-Transport', 'Email send failed', {
      message: err?.message,
      ...describeSendError(err),
      region: envValue('AWS_REGION'),
      recipientCount: recipients.length,
      attachmentCount: attachments.length,
    });
    throw err;
  }
}
