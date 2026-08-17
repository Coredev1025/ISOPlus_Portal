import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/auditLogger.js', () => ({
  logAuditTrail: vi.fn(async () => {}),
}));

import { logAuditTrail } from '../../../src/utils/auditLogger.js';
import { logXeroAudit } from '../../../src/utils/xeroAuditHelpers.js';
import { AUDIT_CATEGORY_XERO } from '../../../src/constants/audit.js';

describe('logXeroAudit', () => {
  beforeEach(() => {
    vi.mocked(logAuditTrail).mockClear();
  });

  it('stamps category xero on every Xero audit event', async () => {
    await logXeroAudit({
      workspaceId: 'ws-1',
      action: 'Connected Xero',
      detail: 'Xero integration connected',
    });

    expect(logAuditTrail).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      action: 'Connected Xero',
      detail: 'Xero integration connected',
      category: AUDIT_CATEGORY_XERO,
    });
  });
});
