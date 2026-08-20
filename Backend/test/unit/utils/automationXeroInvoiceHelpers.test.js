import { describe, it, expect } from 'vitest';
import {
  appendXeroLineDateSuffix,
  captureRouteRes,
  isXeroConnectedBusiness,
  xeroPushDocuments,
} from '../../../src/utils/automationXeroInvoiceHelpers.js';

describe('xeroPushDocuments', () => {
  // The generator returns one row per PDF, but a replay concatenates the rows
  // it re-read off PDFLink with the ones it generated. Pushing the same
  // invoice number twice would put two drafts in the client's accountant's
  // Xero for one PDF, which is a billing bug, not a cosmetic one.
  it('keeps one document per invoice number, first seen', () => {
    const docs = xeroPushDocuments([
      { itemId: 'a', invoiceNumber: 'IN-900 (ISO+™)', participant: 'Sam', pdfUrl: 'u1' },
      { itemId: 'b', invoiceNumber: 'IN-900 (ISO+™)', participant: 'Sam', pdfUrl: 'u1' },
      { itemId: 'c', invoiceNumber: 'IN-901 (ISO+™)', participant: 'Alex', pdfUrl: 'u2' },
    ]);

    expect(docs).toEqual([
      { invoiceNumber: 'IN-900 (ISO+™)', participant: 'Sam' },
      { invoiceNumber: 'IN-901 (ISO+™)', participant: 'Alex' },
    ]);
  });

  // A statement row carries no invoice number, and neither does a generator
  // row that produced nothing. Neither can be referenced in Xero.
  it('drops rows with no invoice number', () => {
    expect(xeroPushDocuments([{ itemId: 'a', pdfUrl: 'u1' }])).toEqual([]);
    expect(xeroPushDocuments(undefined)).toEqual([]);
  });

  it('carries no participant key when the row has none', () => {
    expect(xeroPushDocuments([{ invoiceNumber: 'IN-1' }])).toEqual([
      { invoiceNumber: 'IN-1', participant: '' },
    ]);
  });
});

describe('captureRouteRes', () => {
  it('records the status and body a route handler answered with', () => {
    const { res, captured } = captureRouteRes();

    res.status(400).json({ message: 'There is nothing to invoice!' });

    expect(captured).toEqual({ status: 400, body: { message: 'There is nothing to invoice!' } });
  });

  it('defaults the status to 200 when the handler only calls json', () => {
    const { res, captured } = captureRouteRes();

    res.json({ invoiceNumber: 'INV-0001' });

    expect(captured.status).toBe(200);
  });
});

describe('isXeroConnectedBusiness', () => {
  it('is false without a business, without the flag, or without an access token', () => {
    expect(isXeroConnectedBusiness(null)).toBe(false);
    expect(isXeroConnectedBusiness({ xeroTokens: { accessToken: 'a' } })).toBe(false);
    expect(isXeroConnectedBusiness({ xeroIntegrated: true })).toBe(false);
    expect(isXeroConnectedBusiness({ xeroIntegrated: true, xeroTokens: {} })).toBe(false);
  });

  it('is true for an integrated business holding an access token', () => {
    expect(isXeroConnectedBusiness({
      xeroIntegrated: true, xeroTokens: { accessToken: 'a' },
    })).toBe(true);
  });
});

// Pinned character-for-character against the private appendDateSuffix in
// routes/xero.js, which the UI's Xero push passes to the same handler. The two
// must agree: a divergence changes the description on a real Xero draft line.
describe('appendXeroLineDateSuffix', () => {
  it('appends the row date to the description', () => {
    expect(appendXeroLineDateSuffix('Assistance', '16/12/2025')).toBe('Assistance - 16/12/2025');
  });

  it('leaves a description that already ends with that date alone', () => {
    expect(appendXeroLineDateSuffix('Assistance - 16/12/2025', '16/12/2025'))
      .toBe('Assistance - 16/12/2025');
  });

  it('falls back to Service and tolerates a missing date', () => {
    expect(appendXeroLineDateSuffix('', '16/12/2025')).toBe('Service - 16/12/2025');
    expect(appendXeroLineDateSuffix('Assistance', '')).toBe('Assistance');
  });
});
