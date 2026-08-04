import { describe, it, expect } from 'vitest';
import PDFLink from '../../../src/models/PDFLink.js';

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
});
