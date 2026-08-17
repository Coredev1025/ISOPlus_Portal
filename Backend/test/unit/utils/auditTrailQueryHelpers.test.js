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

  it('adds a case-insensitive exact match for category', () => {
    expect(buildAuditListFilter({ workspaceId: 'ws-1', category: 'xero' })).toEqual({
      filter: {
        workspaceId: 'ws-1',
        category: { $regex: '^xero$', $options: 'i' },
      },
    });
  });

  it('escapes regex metacharacters in the category query', () => {
    const { filter } = buildAuditListFilter({ workspaceId: 'ws-1', category: 'xero.' });
    expect(filter.category.$regex).toBe('^xero\\.$');
  });
});
