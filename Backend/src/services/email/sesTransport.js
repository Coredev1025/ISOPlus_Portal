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
// EMAIL_FROM is both the default From and the deliberate opt-in: the AWS
// credential is shared with S3, so its presence alone must not turn on
// customer email. Only the sending identity's domain is verified in SES
// (dev.isoplus.online in dev), so a user-configured From on another domain
// will be rejected by SES — the error names the address.

import nodemailer from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { info, error } from '../../utils/logger.js';

let transporter = null;

/** Trimmed env value, or '' for unset/blank — blank and absent mean the same here. */
function envValue(name) {
  return String(process.env[name] ?? '').trim();
}

/**
 * True only when the AWS credential, region and a From address are all present.
 * Any one missing means delivery is off, rather than half on.
 *
 * `from` is the workspace's own Email From, off the automation settings block.
 * When a workspace has configured one, that IS the sending identity, so
 * requiring EMAIL_FROM as well would refuse to send an email whose sender is
 * already known — which is what it did, and why a fully configured workspace
 * could sit unable to deliver on an environment that simply had no default.
 *
 * The deployment-level gate is not lost by this. AUTOMATION_ENABLED still has
 * to be on for the scheduler to fan out at all, and the AWS credential still
 * has to be present here; what changes is that the *sender address* may come
 * from the workspace rather than only from the environment.
 */
export function isEmailTransportConfigured({ from = null } = {}) {
  const sender = String(from ?? '').trim() || envValue('EMAIL_FROM');
  return Boolean(
    envValue('AWS_ACCESS_KEY_ID')
    && envValue('AWS_SECRET_ACCESS_KEY')
    && envValue('AWS_REGION')
    && sender,
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
 * Send one composed message through SES.
 *
 * @param {object} message
 * @param {string} [message.from] Defaults to EMAIL_FROM when the settings block has none.
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
  // The same question the preflight gate asked, with the same argument. Asking
  // it without `from` is how a workspace that had configured its own Email From
  // passed the gate that decides whether to generate — burning a real invoice
  // number off Business.documentNumbering — and was then refused here.
  if (!isEmailTransportConfigured({ from })) {
    throw new Error(
      'Email transport is not configured: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and '
      + 'AWS_REGION must all be set, and a From address must come from either the '
      + "workspace's Email From or EMAIL_FROM.",
    );
  }

  const envelope = {
    from: from || envValue('EMAIL_FROM'),
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
    error('SES-Transport', 'Email send failed', {
      message: err?.message,
      region: envValue('AWS_REGION'),
      recipientCount: recipients.length,
      attachmentCount: attachments.length,
    });
    throw err;
  }
}
