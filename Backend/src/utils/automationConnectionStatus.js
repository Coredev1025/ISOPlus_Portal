/**
 * The three states the System Health connection grid renders, matching the
 * wording in the source spec.
 */
export const CONNECTED = 'connected';
export const DISCONNECTED = 'disconnected';
export const NEEDS_REAUTH = 'needs_reauth';

/**
 * One client's accounting-integration status, derived from its Business row.
 *
 * Xero only: MYOB and QuickBooks are disabled stubs in the Accounting
 * Integrations tab, so there is no state to read for them.
 *
 * A Xero refresh token dies after 60 days idle, which is what makes
 * `refreshTokenExpiresAt` the natural re-auth signal — but `npm run schema`
 * reports it as declared-and-absent on existing businesses. An absent or
 * unparseable value is therefore read as "not recorded", not "expired": a grid
 * that flags every client on day one is a grid nobody reads twice. A backfill
 * would make this exact, and belongs to the epic that owns the field.
 */
export function xeroConnectionStatus(business, now = new Date()) {
  if (!business?.xeroIntegrated) return DISCONNECTED;

  const raw = business.xeroTokens?.refreshTokenExpiresAt;
  if (raw === null || raw === undefined) return CONNECTED;

  const expiresAt = new Date(raw).getTime();
  if (Number.isNaN(expiresAt)) return CONNECTED;

  return expiresAt <= now.getTime() ? NEEDS_REAUTH : CONNECTED;
}
