import { describe, expect, it } from 'vitest';
import {
  persistXeroConnection,
  resolveConnectTenantId,
  saveConnectedXeroBusiness,
} from '../../../src/utils/xeroConnectHelpers.js';
import Business from '../../../src/models/Business.js';
import AuditTrail from '../../../src/models/AuditTrail.js';

const tokens = {
  access_token: 'access',
  refresh_token: 'refresh',
  expires_at: 9,
};

describe('xeroConnectHelpers', () => {
  it('prefers tenantId then organisation.organisationId', () => {
    expect(resolveConnectTenantId({ tenantId: ' t1 ' })).toBe('t1');
    expect(
      resolveConnectTenantId({ organization: { organisationId: ' org-1 ' } })
    ).toBe('org-1');
    expect(resolveConnectTenantId({})).toBeNull();
  });

  it('updates an existing business and writes a Xero audit row', async () => {
    await Business.create({ workspaceId: 'ws-existing', name: 'Old' });
    const saved = await saveConnectedXeroBusiness({
      workspaceId: 'ws-existing',
      tokens,
      organization: { organisationId: 'tenant-2', name: 'New Org' },
    });
    expect(saved.error).toBeUndefined();
    const row = await Business.findOne({ workspaceId: 'ws-existing' }).lean();
    expect(row.xeroIntegrated).toBe(true);
    expect(row.xeroTenantId).toBe('tenant-2');
    expect(row.xeroOrganization.name).toBe('New Org');
    expect(await AuditTrail.countDocuments({ workspaceId: 'ws-existing' })).toBe(1);
  });

  it('updates an existing business without replacing organisation when none is sent', async () => {
    await Business.create({
      workspaceId: 'ws-keep-org',
      xeroOrganization: { organisationId: 'old', name: 'Keep' },
    });
    const saved = await persistXeroConnection({
      workspaceId: 'ws-keep-org',
      tokens,
      tenantId: 'tenant-3',
    });
    expect(saved.error).toBeUndefined();
    const row = await Business.findOne({ workspaceId: 'ws-keep-org' }).lean();
    expect(row.xeroTenantId).toBe('tenant-3');
    expect(row.xeroOrganization.name).toBe('Keep');
  });

  it('returns missing_tokens when the token set is incomplete', async () => {
    const result = await persistXeroConnection({
      workspaceId: 'ws-tokens',
      tokens: { access_token: 'only' },
      organization: { organisationId: 't' },
    });
    expect(result).toEqual({ error: 'missing_tokens' });
  });
});
