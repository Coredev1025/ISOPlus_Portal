// Send one real email through the configured SES transport, to prove the
// credentials and the transport work before any automation run depends on them.
//
//   node scripts/send-test-email.mjs you@example.com [--attach <path>]
//
// Reads the same variables sesTransport.js does — AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_REGION and EMAIL_FROM — from Backend/.env. Sends
// exactly one message to exactly the address given on the command line: no
// recipient resolution, no automation data, nothing that could reach a client
// by accident.
//
// In dev the IAM key only permits allowlisted recipient domains, so use the SES
// simulator addresses (success@/bounce@/complaint@simulator.amazonses.com)
// rather than a real mailbox — the suppression list is account-wide.

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

// The same all-or-nothing check the worker makes, reported one variable at a
// time so the missing one is named rather than inferred. The secret is only
// ever reported as set or missing, never printed.
const REQUIRED_ENV = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'EMAIL_FROM',
];

if (!isEmailTransportConfigured()) {
  console.error('SES delivery is not configured. Set these in Backend/.env:');
  for (const name of REQUIRED_ENV) {
    console.error(`  ${name.padEnd(21)} ${String(process.env[name] ?? '').trim() ? 'set' : 'MISSING'}`);
  }
  process.exit(1);
}

// SES_TEST_FROM only to send from a second verified identity without editing
// .env; EMAIL_FROM is the address the automation itself sends as, and
// isEmailTransportConfigured() has already established it is set.
const from = process.env.SES_TEST_FROM || process.env.EMAIL_FROM;

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
    '<p>It confirms the SESv2 transport and the AWS credentials both work.',
    'No automation data was used and no client was contacted.</p>',
    attachments.length
      ? `<p>Attached: <strong>${attachments[0].filename}</strong> — a real PDF from a local automation run.</p>`
      : '',
    `<p style="color:#666;font-size:12px">Sent ${sentAt} · region ${emailTransportConfig().region}</p>`,
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
