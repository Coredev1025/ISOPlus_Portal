import { describe, expect, it } from 'vitest';
import { signOAuthState, verifyOAuthState } from '../../../src/utils/helpers.js';
import {
  applyIncomingOAuthStateToXeroClient,
  buildXeroConsentUrl,
  captureFrontendOriginFromRequest,
  payloadFromXeroOAuthState,
} from '../../../src/utils/xeroOAuthStateHelpers.js';

describe('xeroOAuthStateHelpers', () => {
  it('puts a signed workspace/origin/user JWT on the Xero consent URL', () => {
    const url = buildXeroConsentUrl(
      'https://login.xero.com/identity/connect/authorize?foo=1',
      'ws-1',
      'http://localhost:3100',
      'user-1'
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://login.xero.com/identity/connect/authorize'
    );
    const verified = verifyOAuthState(parsed.searchParams.get('state'));
    expect(verified.ok).toBe(true);
    expect(verified.payload.flow).toBe('xero');
    expect(verified.payload.workspaceId).toBe('ws-1');
    expect(verified.payload.origin).toBe('http://localhost:3100');
    expect(verified.payload.userId).toBe('user-1');
  });

  it('ignores forged or non-xero state payloads', () => {
    expect(payloadFromXeroOAuthState('not-a-jwt')).toEqual({
      workspaceId: '',
      origin: '',
      userId: '',
      connectTicket: '',
    });
    const otherFlow = signOAuthState({ flow: 'isoplus', workspaceId: 'ws-1', userId: 'u' });
    expect(payloadFromXeroOAuthState(otherFlow).workspaceId).toBe('');
  });

  it('mirrors the callback state onto the Xero client to avoid openid-client mismatch', () => {
    const state = signOAuthState({ flow: 'xero', workspaceId: 'ws-1' });
    const xeroClient = { config: {} };
    applyIncomingOAuthStateToXeroClient(
      xeroClient,
      `/api/xero/callback?code=abc&state=${encodeURIComponent(state)}`
    );
    expect(xeroClient.config.state).toBe(state);
  });

  it('reads the frontend origin from Origin then Referer', () => {
    expect(
      captureFrontendOriginFromRequest({
        get: (header) => (header === 'origin' ? 'http://localhost:3100' : undefined),
      })
    ).toBe('http://localhost:3100');
    expect(
      captureFrontendOriginFromRequest({
        get: (header) =>
          header === 'referer' ? 'http://localhost:3100/workspace/ws-1/finance-settings' : '',
      })
    ).toBe('http://localhost:3100');
  });

  it('returns empty origin when Referer is not a valid URL', () => {
    expect(
      captureFrontendOriginFromRequest({
        get: (header) => (header === 'referer' ? 'not-a-url' : ''),
      })
    ).toBe('');
  });
});
