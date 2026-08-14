import { describe, it, expect } from 'vitest';

import {
  xeroConnectionStatus,
  CONNECTED,
  DISCONNECTED,
  NEEDS_REAUTH,
} from '../../../src/utils/automationConnectionStatus.js';

const NOW = new Date('2026-08-13T00:00:00Z');
const daysFromNow = (d) => NOW.getTime() + d * 24 * 60 * 60 * 1000;

describe('xeroConnectionStatus', () => {
  it('reports disconnected when the integration was never enabled', () => {
    expect(xeroConnectionStatus({ xeroIntegrated: false }, NOW)).toBe(DISCONNECTED);
  });

  it('reports disconnected for a missing business', () => {
    expect(xeroConnectionStatus(null, NOW)).toBe(DISCONNECTED);
    expect(xeroConnectionStatus(undefined, NOW)).toBe(DISCONNECTED);
  });

  it('reports connected when the refresh token is still valid', () => {
    const business = {
      xeroIntegrated: true,
      xeroTokens: { refreshTokenExpiresAt: daysFromNow(30) },
    };
    expect(xeroConnectionStatus(business, NOW)).toBe(CONNECTED);
  });

  it('reports needs_reauth once the refresh token has expired', () => {
    const business = {
      xeroIntegrated: true,
      xeroTokens: { refreshTokenExpiresAt: daysFromNow(-1) },
    };
    expect(xeroConnectionStatus(business, NOW)).toBe(NEEDS_REAUTH);
  });

  it('reports connected when integrated but no expiry was ever stored', () => {
    // `npm run schema` shows xeroTokens.refreshTokenExpiresAt is declared but
    // absent on every existing business. Treating absent as expired would mark
    // the entire client grid as needing re-auth the day this ships, which is
    // the fastest way to make a monitoring screen ignored. Absent means "this
    // document predates the field", not "the token died".
    expect(xeroConnectionStatus({ xeroIntegrated: true }, NOW)).toBe(CONNECTED);
    expect(xeroConnectionStatus({ xeroIntegrated: true, xeroTokens: {} }, NOW)).toBe(CONNECTED);
    expect(
      xeroConnectionStatus({ xeroIntegrated: true, xeroTokens: { refreshTokenExpiresAt: null } }, NOW),
    ).toBe(CONNECTED);
  });

  it('treats an unparseable expiry as absent rather than expired', () => {
    const business = {
      xeroIntegrated: true,
      xeroTokens: { refreshTokenExpiresAt: 'not-a-date' },
    };
    expect(xeroConnectionStatus(business, NOW)).toBe(CONNECTED);
  });
});
