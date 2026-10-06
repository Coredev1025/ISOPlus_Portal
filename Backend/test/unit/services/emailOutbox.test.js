// Backend/test/unit/services/emailOutbox.test.js
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  activeEmailBackendName,
  deliverEmail,
  outboxKeyFor,
} from '../../../src/services/email/outbox.js';

// The delivery seam for Epic 5 part 4. Offline it writes the composed message
// to a file a person can open and check; online it refuses loudly, because a
// transport that silently drops mail is the one failure mode worse than none.

const MESSAGE = {
  kind: 'invoice_automation',
  workspaceId: '55369',
  boardId: 'eNiJpH14PN3',
  periodKey: '20260814-0900',
  block: {
    recipient: 'billing_contact',
    sendMethod: 'isoplus',
    replyTo: 'billing@iso-plus.com.au',
    emailSubject: 'Your invoice',
    emailMessage: 'Please find your invoice attached.',
  },
};

// Every variable that decides which backend runs, saved and restored around
// each test. utils/logger.js calls dotenv.config() at import and outbox.js
// imports it, so a developer's Backend/.env is loaded into this suite while CI
// has none of these set. Anything left unsaved here is a test that passes on
// the PR and fails on a working machine, or the reverse.
const BACKEND_ENV = [
  'ISOPLUS_OFFLINE',
  'LOCAL_FILE_ROOT',
  'EMAIL_BACKEND',
  'EMAIL_FROM',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
];

describe('emailOutbox', () => {
  const saved = {};
  let root;

  beforeEach(() => {
    for (const key of BACKEND_ENV) saved[key] = process.env[key];
    root = mkdtempSync(join(tmpdir(), 'email-outbox-'));
    process.env.LOCAL_FILE_ROOT = root;
  });

  afterEach(() => {
    for (const key of BACKEND_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('derives the outbox key from the job identity, matching the queue jobId shape', () => {
    expect(outboxKeyFor(MESSAGE)).toBe(
      'outbox/55369/invoice_automation-eNiJpH14PN3-20260814-0900.json',
    );
  });

  it('keys a per-participant message separately so previews cannot overwrite each other', () => {
    // A client_participant run composes one message per participant for the
    // same board and slot. Without a recipient component every one of them
    // resolves to the same path and only the last survives — the preview would
    // show one email where the run actually sent five.
    const jane = outboxKeyFor({ ...MESSAGE, recipientKey: 'Jane Smith' });
    const david = outboxKeyFor({ ...MESSAGE, recipientKey: 'David Brown' });

    expect(jane).not.toBe(david);
    expect(jane).toBe(
      'outbox/55369/invoice_automation-eNiJpH14PN3-20260814-0900-jane-smith.json',
    );
    // A key that would escape the store or collide once slugified is refused
    // by the resolver, so the slug must stay path-safe.
    expect(outboxKeyFor({ ...MESSAGE, recipientKey: '../../etc/passwd' })).not.toContain('..');
  });

  it('offline: writes one file per participant rather than overwriting a shared path', async () => {
    process.env.ISOPLUS_OFFLINE = '1';

    await deliverEmail({ ...MESSAGE, recipientKey: 'Jane Smith' });
    await deliverEmail({ ...MESSAGE, recipientKey: 'David Brown' });

    expect(readdirSync(join(root, 'outbox/55369')).sort()).toEqual([
      'invoice_automation-eNiJpH14PN3-20260814-0900-david-brown.json',
      'invoice_automation-eNiJpH14PN3-20260814-0900-jane-smith.json',
    ]);
  });

  it('offline: writes the composed message where a person can read it', async () => {
    process.env.ISOPLUS_OFFLINE = '1';

    const result = await deliverEmail(MESSAGE);

    expect(result.delivered).toBe(false);
    expect(result.outboxKey).toBe(outboxKeyFor(MESSAGE));
    const written = JSON.parse(
      readFileSync(join(root, result.outboxKey), 'utf8'),
    );
    expect(written.subject).toBe('Your invoice');
    expect(written.replyTo).toBe('billing@iso-plus.com.au');
    expect(written.body).toBe('Please find your invoice attached.');
    expect(written.periodKey).toBe('20260814-0900');
    expect(written.composedAt).toBeTruthy();
  });

  // Same slot, same file: a redelivered at-least-once job overwrites its own
  // preview rather than accumulating duplicates — the outbox inherits the
  // pipeline's idempotency instead of undermining its evidence.
  it('offline: a redelivery of the same slot overwrites, not duplicates', async () => {
    process.env.ISOPLUS_OFFLINE = '1';

    await deliverEmail(MESSAGE);
    await deliverEmail(MESSAGE);

    expect(readdirSync(join(root, 'outbox/55369'))).toHaveLength(1);
  });

  it('online with no transport configured: refuses loudly rather than pretending to send', async () => {
    // Delivery exists now, so the old "not implemented" wording is gone — but
    // the property it protected has to hold: an environment that is online
    // with no sending configuration must not quietly write a preview nobody
    // reads while a client waits for an invoice.
    process.env.ISOPLUS_OFFLINE = '0';
    delete process.env.EMAIL_BACKEND;
    delete process.env.EMAIL_FROM;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_REGION;

    await expect(deliverEmail(MESSAGE)).rejects.toThrow(/not configured/i);
  });

  // KAN-270: Email From is application-level configuration now — EMAIL_FROM
  // is the only thing that turns delivery on, and activeEmailBackendName no
  // longer takes a per-message override to check. Asserted through
  // activeEmailBackendName rather than deliverEmail because this is the
  // question the worker asks BEFORE generating, and answering it must not
  // depend on a recipient resolving or on SES being reachable.
  it('online: EMAIL_FROM alone (with the AWS credential) turns on the ses backend', () => {
    process.env.ISOPLUS_OFFLINE = '0';
    delete process.env.EMAIL_BACKEND;
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'example-secret';
    process.env.AWS_REGION = 'ap-southeast-2';

    delete process.env.EMAIL_FROM;
    expect(activeEmailBackendName()).toBeNull();

    process.env.EMAIL_FROM = 'noreply@dev.isoplus.online';
    expect(activeEmailBackendName()).toBe('ses');
  });
});
