import jwt from 'jsonwebtoken';

export function normalizePortalUserId(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object' && typeof value.toString === 'function') {
    const text = value.toString();
    return text && text !== '[object Object]' ? text.trim() : '';
  }
  return '';
}

export function readXeroOAuthSessionUser(req) {
  const token = req?.session?.token;
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    const userId = normalizePortalUserId(user?.userId);
    if (!userId) return null;
    return {
      userId,
      role: user.role,
      email: typeof user.email === 'string' ? user.email : '',
    };
  } catch {
    return null;
  }
}

export function xeroOAuthStateMatchesSession(payload, sessionUser) {
  const stateUserId = normalizePortalUserId(payload?.userId);
  const sessionUserId = normalizePortalUserId(sessionUser?.userId);
  if (!stateUserId || !sessionUserId) return false;
  return stateUserId === sessionUserId;
}
