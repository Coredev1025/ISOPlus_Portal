import { describe, it, expect } from 'vitest';
import { AUDIT_CATEGORY_XERO } from '@/constants/audit';
import {
  buildXeroAuditListParams,
  mapXeroAuditItems,
  parseXeroAuditListResponse,
} from '@/lib/xero-connection-audit-logs-helpers';

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

describe('buildXeroAuditListParams', () => {
  it('requests newest Xero events first with pagination', () => {
    expect(buildXeroAuditListParams({ workspaceId: 'ws-1', page: 2 })).toEqual({
      workspaceId: 'ws-1',
      category: AUDIT_CATEGORY_XERO,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      page: 2,
      limit: 20,
    });
  });
});

describe('parseXeroAuditListResponse', () => {
  it('reads items and page metadata from the audit list payload', () => {
    expect(
      parseXeroAuditListResponse({
        items: [
          {
            _id: 'new',
            createdAt: '2026-08-18T10:00:00.000Z',
            action: 'Connected Xero',
            detail: 'Latest',
            success: true,
          },
        ],
        total: 21,
        page: 1,
        totalPages: 2,
      })
    ).toEqual({
      items: [
        {
          id: 'new',
          createdAt: '2026-08-18T10:00:00.000Z',
          action: 'Connected Xero',
          detail: 'Latest',
          user: '',
          success: true,
        },
      ],
      page: 1,
      totalPages: 2,
      total: 21,
    });
  });
});
