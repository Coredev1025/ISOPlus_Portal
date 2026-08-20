import { describe, it, expect } from 'vitest';
import PDFLink from '../../../src/models/PDFLink.js';
import { DELIVERY_STATES, DELIVERY_STATE_GENERATED } from '../../../src/constants/automation.js';

describe('PDFLink model', () => {
  it('requires itemId, workspaceId, pdfLink and type', async () => {
    await expect(PDFLink.create({})).rejects.toThrow();
  });

  it('creates with defaults', async () => {
    const row = await PDFLink.create({
      itemId: 'i1',
      workspaceId: 'ws',
      pdfLink: 'https://example.com/a.pdf',
      type: 'invoice',
    });
    expect(row.SignatureStatus).toBe('Unsigned');
    expect(row.isDeleted).toBe(false);
  });

  it('starts every document at the generated delivery state, with no event yet', async () => {
    const row = await PDFLink.create({
      itemId: 'i2',
      workspaceId: 'ws',
      pdfLink: 'https://example.com/b.pdf',
      type: 'NDIS Invoice',
    });
    expect(row.deliveryState).toBe(DELIVERY_STATE_GENERATED);
    expect(row.deliveryMessageId).toBeUndefined();
    expect(row.deliveryDetail).toBeUndefined();
    expect(row.deliveryUpdatedAt).toBeUndefined();
  });

  it('refuses a delivery state outside the known set', async () => {
    await expect(
      PDFLink.create({
        itemId: 'i3',
        workspaceId: 'ws',
        pdfLink: 'https://example.com/c.pdf',
        type: 'NDIS Invoice',
        deliveryState: 'exploded',
      })
    ).rejects.toThrow();
    expect(DELIVERY_STATES).toContain(DELIVERY_STATE_GENERATED);
  });
});
