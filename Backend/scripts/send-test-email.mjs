// Send one real email through the configured SES SMTP transport, to prove the
// credentials and the transport work before any automation run depends on them.
//
//   node scripts/send-test-email.mjs you@example.com [--attach <path>]
//
// Reads SES_SMTP_* from Backend/.env. Sends exactly one message to exactly the
// address given on the command line — no recipient resolution, no automation
// data, nothing that could reach a client by accident.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { emailTransportConfig, isEmailTransportConfigured, sendEmail } from '../src/services/email/sesTransport.js';

function parseArgs(argv) {
  const to = argv.find((arg) => !arg.startsWith('--'));
  const attachIndex = argv.indexOf('--attach');
  return { to, attach: attachIndex === -1 ? null : argv[attachIndex + 1] };
}

const { to, attach } = parseArgs(process.argv.slice(2));

if (!to) {
  console.error('usage: node scripts/send-test-email.mjs <recipient> [--attach <pdf path>]');
  process.exit(1);
}

if (!isEmailTransportConfigured()) {
  const config = emailTransportConfig();
  console.error('SES SMTP is not configured. Set these in Backend/.env:');
  console.error(`  SES_SMTP_HOST      ${config.host ? 'set' : 'MISSING'}`);
  console.error(`  SES_SMTP_USER      ${config.user ? 'set' : 'MISSING'}`);
  console.error('  SES_SMTP_PASSWORD  (never printed; set it yourself)');
  process.exit(1);
}

const from = process.env.SES_TEST_FROM || process.env.EMAIL_FROM_DEFAULT;
if (!from) {
  console.error('Set SES_TEST_FROM in Backend/.env to an address SES has verified for this account.');
  process.exit(1);
}

const attachments = attach
  ? [{ filename: basename(attach), content: readFileSync(attach) }]
  : [];

const sentAt = new Date().toISOString();
const result = await sendEmail({
  from,
  to,
  subject: 'ISO+ Portal — SES delivery test',
  html: [
    '<p>This is a test message from the ISO+ Portal automation pipeline.</p>',
    '<p>It confirms the SES SMTP transport, the credentials and TLS all work.',
    'No automation data was used and no client was contacted.</p>',
    attachments.length
      ? `<p>Attached: <strong>${attachments[0].filename}</strong> — a real PDF from a local automation run.</p>`
      : '',
    `<p style="color:#666;font-size:12px">Sent ${sentAt} · host ${emailTransportConfig().host}</p>`,
  ].join('\n'),
  text: `ISO+ Portal SES delivery test. Sent ${sentAt}.`,
  attachments,
});

console.log(JSON.stringify({
  to,
  from,
  messageId: result.messageId,
  accepted: result.accepted.length,
  rejected: result.rejected,
  attachments: attachments.map((a) => a.filename),
}, null, 1));
