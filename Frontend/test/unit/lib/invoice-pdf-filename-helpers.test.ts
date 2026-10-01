import { describe, it, expect } from 'vitest';

import { invoicePdfDownloadFilename } from '@/lib/invoice-generator-pdf-helpers';

/**
 * Download names must match the S3 object basename written by
 * webhookParticipantTaxPdfHelpers:
 *   INV-{number}-ISO+™-{participant with spaces→hyphens}.pdf
 *
 * `invoicePdfDownloadFilename` prefers that stored basename (so older
 * invoices keep their key) and otherwise builds the same shape. The ™
 * stays in the download name; the proxy ASCII-encodes only the HTTP header.
 */
describe('invoicePdfDownloadFilename', () => {
  it('builds INV-{number}-ISO+™-{participant}.pdf with spaces as hyphens', () => {
    expect(invoicePdfDownloadFilename({
      invoiceNumber: 'INV-1109',
      participantName: 'Jane Smith',
    })).toBe('INV-1109-ISO+™-Jane-Smith.pdf');
  });

  it('strips the display suffix "(ISO+™)" from the invoice number', () => {
    expect(invoicePdfDownloadFilename({
      invoiceNumber: 'INV-21 (ISO+™)',
      participantName: 'Jane Smith',
    })).toBe('INV-21-ISO+™-Jane-Smith.pdf');
  });

  it('reads the decoded S3 object basename, including ISO+™', () => {
    expect(invoicePdfDownloadFilename({
      fileUrl:
        'https://isoplus-portal-dev.s3.ap-southeast-2.amazonaws.com/output/55515/board/Participant-invoices/INV-14-ISO%2B%E2%84%A2-Jane-Smith.pdf?X-Amz-Signature=abc',
    })).toBe('INV-14-ISO+™-Jane-Smith.pdf');
  });

  it('falls back when the URL has no pdf segment', () => {
    expect(invoicePdfDownloadFilename({
      fileUrl: 'https://example.test/nope',
      invoiceNumber: 'INV-21 (ISO+™)',
      participantName: 'Jane Smith',
    })).toBe('INV-21-ISO+™-Jane-Smith.pdf');
  });

  it('prefers the stored S3 basename so old invoices keep their original name', () => {
    expect(invoicePdfDownloadFilename({
      fileUrl:
        'https://bucket.s3.amazonaws.com/output/ws/board/Participant-invoices/INV-1109-ISO%2B%E2%84%A2-Jane-Smith.pdf',
      invoiceNumber: 'INV-1109 (ISO+™)',
      participantName: 'Someone Else',
    })).toBe('INV-1109-ISO+™-Jane-Smith.pdf');
  });

  it('falls back to building the origin format when the URL has no usable name', () => {
    expect(invoicePdfDownloadFilename({
      fileUrl: 'https://bucket.s3.amazonaws.com/output/ws/board/Participant-invoices/',
      invoiceNumber: 'INV-21 (ISO+™)',
      participantName: 'Jane Smith',
    })).toBe('INV-21-ISO+™-Jane-Smith.pdf');
  });
});
