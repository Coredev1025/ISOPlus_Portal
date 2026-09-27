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

// KAN-266 asserts on what the refusal branch actually records, so the logger
// has to be observable rather than a side effect nothing can see.
vi.mock('../../../src/utils/logger.js', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), default: {},
}));

import { localOutboxBackend, sesBackend } from '../../../src/services/email/backends.js';
import { warn } from '../../../src/utils/logger.js';
import { DELIVERY_REFUSAL_MESSAGES } from '../../../src/constants/automation.js';
import { sendEmail } from '../../../src/services/email/sesTransport.js';
import { resolveRecipient } from '../../../src/services/email/recipients.js';
import { getS3File } from '../../../src/utils/uploadS3.js';
import EmailSend from '../../../src/models/EmailSend.js';
import PDFLink from '../../../src/models/PDFLink.js';

const MESSAGE = {
  kind: 'invoice_automation',
  workspaceId: '55390',
  boardId: 'board-a',
  periodKey: '20250201-0900',
  recipientKey: 'Jane Smith',
  block: {
    recipient: 'billing_contact',
    sendMethod: 'isoplus',
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

  it('resolves the participant to a real address and sends', async () => {
    const result = await sesBackend.deliver(MESSAGE);

    expect(result.delivered).toBe(true);
    // KAN-272: no recipientType any more — resolveRecipient derives the
    // mailbox itself from the participant's own profile.
    expect(resolveRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: '55390', participant: 'Jane Smith' }),
    );
    expect(resolveRecipient.mock.calls[0][0]).not.toHaveProperty('recipientType');
    const sent = sendEmail.mock.calls[0][0];
    // KAN-270: Email From is application-level configuration now — sendEmail
    // is not given a per-workspace From at all, only sesTransport.js (env +
    // the hardcoded display name) decides it.
    expect(sent).not.toHaveProperty('from');
    expect(sent).toMatchObject({
      to: 'jane@example.test',
      cc: 'copy@provider.test',
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

  /**
   * KAN-266. A refused send used to record kind/workspace/board/period and
   * nothing else — no addresses, and not the provider's own error. On
   * portal-dev that made a sender-address failure indistinguishable from a
   * recipient one, and the logs could not settle it either way.
   *
   * SES authorises ses:SendEmail against the *sending identity* ARN, so a From
   * outside the policy's identities produces the same AccessDenied as a
   * disallowed recipient. Both addresses have to be on the line.
   */
  it('names the sender, the recipient and the provider error when a send is refused', async () => {
    sendEmail.mockRejectedValueOnce(Object.assign(
      new Error("not authorized to perform 'ses:SendEmail' on resource identity/billing@provider.test"),
      {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 403, requestId: 'aws-req-7f3c', attempts: 1 },
      },
    ));

    await sesBackend.deliver(MESSAGE);

    const refusal = warn.mock.calls.find(([, message]) => /refused the send/i.test(message));
    expect(refusal, 'the refusal should be logged').toBeDefined();
    const [, , context] = refusal;
    // KAN-270: the From logged here is the app-level sending identity
    // (emailTransportConfig().from, mocked above), not a per-workspace value.
    expect(context).toMatchObject({
      to: 'jane@example.test',
      from: 'noreply@test',
      errorName: 'AccessDeniedException',
    });
    // The provider's own words, which is the part that actually says which
    // address it objected to.
    expect(context.errorMessage).toMatch(/identity\/billing@provider\.test/);
  });

  /**
   * The request id is what makes a refusal *definitive* rather than merely
   * described: it is the handle that pulls the exact call out of CloudTrail,
   * where the IAM decision — and the condition that produced it — is recorded.
   * Without it you are still inferring from an error string.
   */
  it('carries the AWS request id and status, so the call can be found in CloudTrail', async () => {
    sendEmail.mockRejectedValueOnce(Object.assign(
      new Error('not authorized to perform ses:SendEmail'),
      {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 403, requestId: 'aws-req-7f3c', attempts: 1 },
      },
    ));

    await sesBackend.deliver(MESSAGE);

    const [, , context] = warn.mock.calls.find(([, m]) => /refused the send/i.test(m));
    expect(context).toMatchObject({
      awsRequestId: 'aws-req-7f3c',
      httpStatusCode: 403,
      fault: 'client',
    });
  });

  it('still throws non-policy send failures so the job retries', async () => {
    sendEmail.mockRejectedValueOnce(new Error('Throttling: Maximum sending rate exceeded'));

    await expect(sesBackend.deliver(MESSAGE)).rejects.toThrow(/sending rate/);
  });

  // A private-bucket URL is presigned, so it carries a query string. Splitting
  // on '.amazonaws.com/' and keeping the remainder made the S3 key
  // 'output/.../INV-1.pdf?X-Amz-Algorithm=...', which GetObject cannot find —
  // and an unreadable attachment is skipped rather than thrown, so the client
  // received an invoice email with no invoice in it. Every earlier test here
  // used an /api/local-files/ URL, which has no query string, so the whole
  // production shape went uncovered.
  it('reads the object key from a presigned S3 URL without its query string', async () => {
    const key = 'output/55390/board-a/NDIS-invoices/INV-1.pdf';
    const presigned = `https://iso-bucket.s3.ap-southeast-2.amazonaws.com/${key}`
      + '?X-Amz-Algorithm=AWS4-HMAC-SHA256'
      + '&X-Amz-Credential=AKIA%2F20260819%2Fap-southeast-2%2Fs3%2Faws4_request'
      + '&X-Amz-Expires=604800&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host';

    const result = await sesBackend.deliver({ ...MESSAGE, attachments: [presigned] });

    expect(getS3File).toHaveBeenCalledWith(key);
    expect(result.skippedAttachments).toBe(0);
    const [{ attachments }] = sendEmail.mock.calls[0];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('INV-1.pdf');
  });

  // The public-bucket URL getS3FileUrl builds percent-encodes '+' in the key,
  // and a generated filename can carry a space. Both have to survive back into
  // the literal key S3 stored.
  it('decodes a percent-encoded key and ignores a fragment', async () => {
    await sesBackend.deliver({
      ...MESSAGE,
      attachments: ['https://iso-public.s3.ap-southeast-2.amazonaws.com/output/55390/Jane%20Smith%2BCo/INV-2.pdf#page=1'],
    });

    expect(getS3File).toHaveBeenCalledWith('output/55390/Jane Smith+Co/INV-2.pdf');
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

/**
 * The message id is the only handle a later SES event has on the documents an
 * email carried, so the send has to record it against those PDFLink rows.
 */
describe('sesBackend delivery tracking', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await PDFLink.deleteMany({});
  });

  /** The PDFLink row the automation generator wrote for MESSAGE's attachment. */
  function generatedRow(overrides = {}) {
    return PDFLink.create({
      workspaceId: '55390',
      boardId: 'board-a',
      itemId: 'item-1',
      type: 'NDIS Invoice',
      periodKey: '20250201-0900',
      pdfLink: MESSAGE.attachments[0],
      ...overrides,
    });
  }

  it('stamps the sent state and the message id on the documents it just emailed', async () => {
    await generatedRow();

    await sesBackend.deliver(MESSAGE);

    const row = await PDFLink.findOne({ workspaceId: '55390' }).lean();
    expect(row.deliveryMessageId).toBe('msg-1');
    expect(row.deliveryState).toBe('sent');
  });

  it('leaves another workspace\'s row alone even when the URL matches', async () => {
    await generatedRow({ workspaceId: '99999' });

    await sesBackend.deliver(MESSAGE);

    const row = await PDFLink.findOne({ workspaceId: '99999' }).lean();
    expect(row.deliveryState).toBe('generated');
    expect(row.deliveryMessageId).toBeUndefined();
  });

  it('still reports the send as delivered when the tracking write fails', async () => {
    // The email has already left; throwing here would make the worker retry
    // and send it twice.
    const spy = vi.spyOn(PDFLink, 'updateMany').mockRejectedValueOnce(new Error('mongo down'));

    const result = await sesBackend.deliver(MESSAGE);

    expect(result.delivered).toBe(true);
    spy.mockRestore();
  });
});

/**
 * KAN-266. The copy a client reads must not name a cause the code has not
 * established. Any 403 becomes `access_denied`, and on portal-dev that was a
 * From-address problem being reported as a recipient one.
 */
describe('the refusal message shown for access_denied', () => {
  const message = DELIVERY_REFUSAL_MESSAGES.access_denied;

  it('does not blame the recipient', () => {
    expect(message).not.toMatch(/refused this recipient/i);
  });

  it('points at the sender as well, since that is what SES authorises on', () => {
    expect(message).toMatch(/email from/i);
  });

  it('still says plainly that the send was refused', () => {
    expect(message).toMatch(/refused/i);
  });
});
