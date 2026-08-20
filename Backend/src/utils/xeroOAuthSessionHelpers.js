import jwt from 'jsonwebtoken';

export function normalizePortalUserId(value) {
  const text = String(value ?? '').trim();
  return text && text !== '[object Object]' ? text : '';
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
