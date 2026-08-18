import { describe, expect, it } from 'vitest';
import {
  XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
  XERO_OAUTH_REASON_INVALID_STATE,
  XERO_OAUTH_REASON_MISSING_CODE,
  XERO_OAUTH_REASON_NO_ORGANISATION,
  XERO_OAUTH_REASON_OAUTH_FAILED,
  XERO_OAUTH_REASON_SAVE_FAILED,
} from '../../../src/constants/xeroOAuth.js';
import { xeroConnectFailureDetail } from '../../../src/utils/xeroOAuthAuditHelpers.js';

describe('xeroOAuthAuditHelpers', () => {
  it('maps OAuth failure reason codes to user-facing audit detail', () => {
    expect(xeroConnectFailureDetail(XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED)).toMatch(
      /could not be verified/i
    );
    expect(xeroConnectFailureDetail(XERO_OAUTH_REASON_NO_ORGANISATION)).toMatch(
      /no xero organisation was selected/i
    );
    expect(xeroConnectFailureDetail(XERO_OAUTH_REASON_OAUTH_FAILED)).toMatch(
      /could not complete the xero authentication/i
    );
    expect(xeroConnectFailureDetail('unknown_reason')).toMatch(
      /could not complete the xero authentication/i
    );
  });

  it('covers every allow-listed OAuth failure reason', () => {
    for (const reason of [
      XERO_OAUTH_REASON_AUTHENTICATION_REQUIRED,
      XERO_OAUTH_REASON_INVALID_STATE,
      XERO_OAUTH_REASON_MISSING_CODE,
      XERO_OAUTH_REASON_OAUTH_FAILED,
      XERO_OAUTH_REASON_NO_ORGANISATION,
      XERO_OAUTH_REASON_SAVE_FAILED,
    ]) {
      expect(xeroConnectFailureDetail(reason)).toBeTruthy();
      expect(xeroConnectFailureDetail(reason)).not.toMatch(/getaddrinfo|stack|Error:/i);
    }
  });
});
