/** In-memory membership cache for /verify re-checks (per process). */
const membershipCache = new Map();

export const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;

export function parseBreakGlassEmails(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isBreakGlassEmail(email, allowlist) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalized || !Array.isArray(allowlist) || allowlist.length === 0) return false;
  return allowlist.includes(normalized);
}

export function resolveBreakGlassEmails(env = process.env) {
  return parseBreakGlassEmails(env.GOOGLE_SUPPORT_BREAK_GLASS_EMAILS || '');
}

/**
 * hasMember 404/400 = unknown / out-of-domain member → deny as not_member.
 * 401 unauthorized_client / 403 API disabled / 5xx → verify_error (couldn't tell).
 */
export function classifyDirectoryMembershipError(err) {
  const code = Number(err?.code ?? err?.status ?? err?.response?.status ?? 0);
  if (code === 404 || code === 400) return 'not_member';
  return 'verify_error';
}

export function getCachedMembership(email) {
  const key = String(email || '').toLowerCase();
  const entry = membershipCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    membershipCache.delete(key);
    return null;
  }
  return entry.result;
}

export function setCachedMembership(email, result, ttlMs = MEMBERSHIP_CACHE_TTL_MS) {
  const key = String(email || '').toLowerCase();
  membershipCache.set(key, { result, expiresAt: Date.now() + ttlMs });
}

export function clearMembershipCache() {
  membershipCache.clear();
}
