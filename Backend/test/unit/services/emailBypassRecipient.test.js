import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

/**
 * The end the override has to hold: the SES backend must send to the bypass
 * address and must not resolve — or reach — the participant's billing contact.
 *
 * Asserting that `resolveRecipient` is never called is the point. A version
 * that resolved the real address and then overwrote it would pass a
 * "sent to the right place" test while still reading participant data it had
 * no need for, and would send to the participant the moment someone reordered
 * two lines.
 */

const resolveRecipient = vi.fn();
const sendEmail = vi.fn(async () => ({ messageId: '<test@ses>' }));

vi.mock('../../../src/services/email/recipients.js', () => ({ resolveRecipient }));
vi.mock('../../../src/services/email/sesTransport.js', () => ({
  sendEmail,
  isEmailTransportConfigured: () => true,
  isAccessDeniedError: () => false,
}));
vi.mock('../../../src/services/email/deliveryEvents.js', () => ({
  recordEmailSend: async () => {},
}));

const { sesBackend } = await import('../../../src/services/email/backends.js');

const message = (extra = {}) => ({
  kind: 'invoice',
  workspaceId: 'ws-1',
  boardId: 'board-1',
  periodKey: '2026-08',
  recipientKey: 'Jane Smith',
  block: { recipient: 'billing_contact', emailSubject: 'S', emailMessage: 'B' },
  attachments: [],
  ...extra,
});

beforeEach(() => {
  resolveRecipient.mockReset();
  resolveRecipient.mockResolvedValue({ address: 'real.participant@example.com', source: 'profile_billing_email' });
  sendEmail.mockClear();
});

describe('sesBackend with bypassEmail', () => {
  it('sends to the override and never resolves the participant', async () => {
    await sesBackend.deliver(message({ bypassEmail: ['me@example.com'] }));

    expect(resolveRecipient).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('me@example.com');
  });

  it('sends to every override address, comma joined', async () => {
    await sesBackend.deliver(message({ bypassEmail: ['a@example.com', 'b@example.com'] }));

    expect(sendEmail.mock.calls[0][0].to).toBe('a@example.com, b@example.com');
  });

  it('resolves the participant normally when no override is given', async () => {
    await sesBackend.deliver(message());

    expect(resolveRecipient).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('real.participant@example.com');
  });

  it('treats an empty override as absent rather than as "send nowhere"', async () => {
    await sesBackend.deliver(message({ bypassEmail: [] }));

    expect(resolveRecipient).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe('real.participant@example.com');
  });

  it('still carries the composed attachments, so the override proves the real path', async () => {
    await sesBackend.deliver(message({ bypassEmail: ['me@example.com'] }));

    const sent = sendEmail.mock.calls[0][0];
    expect(sent.subject).toBe('S');
    expect(sent).toHaveProperty('attachments');
  });
});
