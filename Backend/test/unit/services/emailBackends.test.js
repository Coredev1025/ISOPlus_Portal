import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `isAccessDeniedError` stays real: the access-denied tests below assert
// against the actual predicate, not a copy of it living in this mock.
vi.mock('../../../src/services/email/sesTransport.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isEmailTransportConfigured: vi.fn(() => true),
    sendEmail: vi.fn(async () => ({ messageId: 'msg-1', accepted: ['to@x.test'], rejected: [] })),
    emailTransportConfig: vi.fn(() => ({ region: 'ap-southeast-2', from: 'noreply@test', configured: true })),
  };
});

vi.mock('../../../src/services/email/recipients.js', () => ({
  resolveRecipient: vi.fn(async () => ({ address: 'jane@example.test', source: 'profile_email' })),
}));

vi.mock('../../../src/utils/uploadS3.js', () => ({
  getS3File: vi.fn(async () => Buffer.from('%PDF-1.7 fake')),
}));

import { localOutboxBackend, sesBackend } from '../../../src/services/email/backends.js';
import { sendEmail } from '../../../src/services/email/sesTransport.js';
import { resolveRecipient } from '../../../src/services/email/recipients.js';
import { getS3File } from '../../../src/utils/uploadS3.js';
import EmailSend from '../../../src/models/EmailSend.js';

const MESSAGE = {
  kind: 'invoice_automation',
  workspaceId: '55390',
  boardId: 'board-a',
  periodKey: '20250201-0900',
  recipientKey: 'Jane Smith',
  block: {
    recipient: 'billing_contact',
    sendMethod: 'isoplus',
    emailFrom: 'billing@provider.test',
    replyTo: 'reply@provider.test',
    sendCopyTo: 'copy@provider.test',
    emailSubject: 'Your ISO+ invoice run',
    emailMessage: '<p>Attached.</p>',
  },
  attachments: ['https://files.test/api/local-files/output/55390/board-a/NDIS-invoices/INV-1.pdf'],
};

describe('localOutboxBackend', () => {
  let root;
  const saved = {};

  beforeEach(() => {
    saved.LOCAL_FILE_ROOT = process.env.LOCAL_FILE_ROOT;
    root = mkdtempSync(join(tmpdir(), 'email-backend-'));
    process.env.LOCAL_FILE_ROOT = root;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.LOCAL_FILE_ROOT = saved.LOCAL_FILE_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the composed message where a person can read it, and sends nothing', async () => {
    const result = await localOutboxBackend.deliver(MESSAGE);

    expect(result.delivered).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    const written = JSON.parse(readFileSync(join(root, result.outboxKey), 'utf8'));
    expect(written).toMatchObject({
      kind: 'invoice_automation',
      subject: 'Your ISO+ invoice run',
      recipientType: 'billing_contact',
    });
    expect(written.attachments).toEqual(MESSAGE.attachments);
  });

  it('also prints the composed message, so a local run needs no file hunt', async () => {
    const printed = [];
    await localOutboxBackend.deliver(MESSAGE, { print: (line) => printed.push(line) });

    const body = printed.join('\n');
    expect(body).toContain('Your ISO+ invoice run');
    expect(body).toContain('20250201-0900');
  });

  it('keys one file per participant so per-recipient previews do not overwrite', async () => {
    await localOutboxBackend.deliver(MESSAGE);
    await localOutboxBackend.deliver({ ...MESSAGE, recipientKey: 'David Brown' });

    expect(readdirSync(join(root, 'outbox', '55390'))).toHaveLength(2);
  });
});

describe('sesBackend', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await EmailSend.deleteMany({});
  });

  it('persists the send keyed by message id, so a queue event can be traced to its invoice run', async () => {
    await sesBackend.deliver(MESSAGE);

    const rows = await EmailSend.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      messageId: 'msg-1',
      kind: 'invoice_automation',
      workspaceId: '55390',
      boardId: 'board-a',
      periodKey: '20250201-0900',
      recipientType: 'billing_contact',
    });
  });

  it('persists nothing when the send was refused', async () => {
    resolveRecipient.mockResolvedValueOnce({ address: null, reason: 'profile_not_found' });

    await sesBackend.deliver(MESSAGE);

    expect(await EmailSend.countDocuments({})).toBe(0);
  });

  it('resolves the recipient type to a real address and sends', async () => {
    const result = await sesBackend.deliver(MESSAGE);

    expect(result.delivered).toBe(true);
    expect(resolveRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: '55390', participant: 'Jane Smith', recipientType: 'billing_contact' }),
    );
    const sent = sendEmail.mock.calls[0][0];
    expect(sent).toMatchObject({
      to: 'jane@example.test',
      cc: 'copy@provider.test',
      from: 'billing@provider.test',
      replyTo: 'reply@provider.test',
      subject: 'Your ISO+ invoice run',
      html: '<p>Attached.</p>',
    });
  });

  it('attaches the generated PDF bytes rather than a link a client cannot open', async () => {
    await sesBackend.deliver(MESSAGE);

    expect(getS3File).toHaveBeenCalled();
    const [{ attachments }] = sendEmail.mock.calls[0];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('INV-1.pdf');
    expect(Buffer.isBuffer(attachments[0].content)).toBe(true);
  });

  it('refuses to send when the recipient cannot be resolved, rather than guessing', async () => {
    resolveRecipient.mockResolvedValueOnce({ address: null, reason: 'profile_not_found' });

    const result = await sesBackend.deliver(MESSAGE);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('profile_not_found');
  });

  it('treats an IAM access-denied send as a recorded refusal, not a retryable failure', async () => {
    // Dev sends to recipients outside the allowlisted domains return
    // AccessDenied by design (the IAM guardrail). Retrying can never succeed,
    // so the backend reports it instead of throwing it back to BullMQ.
    sendEmail.mockRejectedValueOnce(
      Object.assign(new Error('not authorized to perform ses:SendEmail'), { name: 'AccessDeniedException' }),
    );

    const result = await sesBackend.deliver(MESSAGE);

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('access_denied');
  });

  it('still throws non-policy send failures so the job retries', async () => {
    sendEmail.mockRejectedValueOnce(new Error('Throttling: Maximum sending rate exceeded'));

    await expect(sesBackend.deliver(MESSAGE)).rejects.toThrow(/sending rate/);
  });

  it('does not let one unreadable attachment silence the whole send', async () => {
    // A missing PDF must not cost the client their invoice email; the send
    // proceeds with what could be read and the gap is reported.
    getS3File.mockRejectedValueOnce(new Error('NoSuchKey'));

    const result = await sesBackend.deliver({
      ...MESSAGE,
      attachments: [...MESSAGE.attachments, 'https://files.test/api/local-files/output/55390/board-a/NDIS-invoices/INV-2.pdf'],
    });

    expect(result.delivered).toBe(true);
    const [{ attachments }] = sendEmail.mock.calls[0];
    expect(attachments).toHaveLength(1);
    expect(result.skippedAttachments).toBe(1);
  });
});
