import { describe, it, expect } from 'vitest';
import { buildAuditListFilter } from '../../../src/utils/auditTrailQueryHelpers.js';

describe('buildAuditListFilter', () => {
  it('rejects a missing workspaceId', () => {
    expect(buildAuditListFilter({})).toEqual({ error: 'Invalid workspaceId' });
  });

  it('filters by workspaceId alone when category is absent', () => {
    expect(buildAuditListFilter({ workspaceId: 'ws-1' })).toEqual({
      filter: { workspaceId: 'ws-1' },
    });
  });

  it('filters by the closed-set category with exact equality', () => {
    expect(buildAuditListFilter({ workspaceId: 'ws-1', category: 'Xero' })).toEqual({
      filter: {
        workspaceId: 'ws-1',
        category: 'Xero',
      },
    });
  });
});
