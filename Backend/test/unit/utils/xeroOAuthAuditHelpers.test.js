import { describe, expect, it } from 'vitest';
import {
  XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
  XERO_OAUTH_REASON_INVALID_STATE,
  XERO_OAUTH_REASON_MISSING_CODE,
  XERO_OAUTH_REASON_NO_ORGANISATION,
  XERO_OAUTH_REASON_OAUTH_FAILED,
  XERO_OAUTH_REASON_SAVE_FAILED,
} from '../../../src/constants/xeroOAuth.js';
import AuditTrail from '../../../src/models/AuditTrail.js';
import { logXeroConnectFailure } from '../../../src/utils/xeroOAuthAuditHelpers.js';

describe('xeroOAuthAuditHelpers', () => {
  it('logs the OAuth failure reason code in audit detail', async () => {
    await logXeroConnectFailure({
      workspaceId: 'ws-1',
      reason: XERO_OAUTH_REASON_NO_ORGANISATION,
      req: { session: { userId: 'user-1' } },
    });

    const row = await AuditTrail.findOne({ workspaceId: 'ws-1' }).lean();
    expect(row.action).toBe('Failed to connect Xero');
    expect(row.detail).toBe(XERO_OAUTH_REASON_NO_ORGANISATION);
    expect(row.success).toBe(false);
  });

  it('covers every allow-listed OAuth failure reason', async () => {
    for (const reason of [
      XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
      XERO_OAUTH_REASON_INVALID_STATE,
      XERO_OAUTH_REASON_MISSING_CODE,
      XERO_OAUTH_REASON_OAUTH_FAILED,
      XERO_OAUTH_REASON_NO_ORGANISATION,
      XERO_OAUTH_REASON_SAVE_FAILED,
    ]) {
      await AuditTrail.deleteMany({});
      await logXeroConnectFailure({
        workspaceId: 'ws-reason',
        reason,
        req: {},
      });
      const row = await AuditTrail.findOne({ workspaceId: 'ws-reason' }).lean();
      expect(row.detail).toBe(reason);
    }
  });

  it('falls back to unknown when the reason is missing', async () => {
    await logXeroConnectFailure({
      workspaceId: 'ws-unknown',
      reason: '',
      req: {},
    });
    const row = await AuditTrail.findOne({ workspaceId: 'ws-unknown' }).lean();
    expect(row.detail).toBe('unknown');
  });
});
