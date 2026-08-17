import { describe, it, expect } from 'vitest';
import { mapXeroAuditItems } from '@/lib/xero-connection-audit-logs-helpers';

describe('mapXeroAuditItems', () => {
  it('returns an empty list when the payload is not an array', () => {
    expect(mapXeroAuditItems(undefined)).toEqual([]);
    expect(mapXeroAuditItems({ items: [] })).toEqual([]);
  });

  it('maps audit rows for the Xero connection activity table', () => {
    expect(
      mapXeroAuditItems([
        {
          _id: 'a1',
          createdAt: '2026-08-01T00:00:00.000Z',
          action: 'Connected Xero',
          detail: 'Linked organisation Acme',
          userEmail: 'owner@example.com',
          success: true,
        },
        {
          createdAt: '2026-08-02T00:00:00.000Z',
          action: 'Process Xero invoice',
          detail: 'Error processing invoice: boom',
          success: false,
        },
      ]),
    ).toEqual([
      {
        id: 'a1',
        createdAt: '2026-08-01T00:00:00.000Z',
        action: 'Connected Xero',
        detail: 'Linked organisation Acme',
        user: 'owner@example.com',
        success: true,
      },
      {
        id: '2026-08-02T00:00:00.000Z',
        createdAt: '2026-08-02T00:00:00.000Z',
        action: 'Process Xero invoice',
        detail: 'Error processing invoice: boom',
        user: '',
        success: false,
      },
    ]);
  });
});
