import jwt from 'jsonwebtoken';
import { toRequiredQueryString } from './securityHelpers.js';

export function readXeroOAuthSessionUser(req) {
  const token = req?.session?.token;
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    const userId = toRequiredQueryString(user?.userId);
    if (!userId) return null;
    return { userId, role: user.role };
  } catch {
    return null;
  }
}

export function xeroOAuthStateMatchesSession(payload, sessionUser) {
  const stateUserId = toRequiredQueryString(payload?.userId);
  const sessionUserId = toRequiredQueryString(sessionUser?.userId);
  if (!stateUserId || !sessionUserId) return false;
  return stateUserId === sessionUserId;
}
