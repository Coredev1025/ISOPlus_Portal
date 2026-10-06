/**
 * Session cookie flags for express-session.
 *
 * Touchpoints: src/app.js, src/index.js, routes/auth.js (logout clearCookie)
 *
 * Frontend (localhost) + API (ngrok HTTPS) is cross-site: browsers only store/
 * send the session on XHR when SameSite=None and Secure. Production already
 * needs that for portal ↔ API split origins. Local http://localhost backends
 * keep SameSite=lax.
 *
 * clearCookie must use the same secure/sameSite/path as the set cookie, or the
 * browser keeps connect.sid after logout (especially SameSite=None; Secure).
 */
export function resolveSessionCookieOptions(env = process.env) {
  const maxAge = 1000 * 60 * 60 * 24;

  if (env.NODE_ENV === 'test') {
    return { secure: false, httpOnly: true, sameSite: 'lax', maxAge };
  }

  const explicit = String(env.SESSION_COOKIE_SAMESITE || '')
    .trim()
    .toLowerCase();
  const backendIsHttps = /^https:\/\//i.test(String(env.BACKEND_URL || '').trim());
  const isProduction = env.NODE_ENV === 'production';
  const crossSite =
    explicit === 'none' || isProduction || (explicit !== 'lax' && backendIsHttps);

  return {
    secure: crossSite,
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    maxAge,
  };
}

/** Options for res.clearCookie('connect.sid', …) — must mirror set-cookie flags. */
export function resolveSessionClearCookieOptions(env = process.env) {
  const { secure, sameSite, httpOnly } = resolveSessionCookieOptions(env);
  return { path: '/', httpOnly, secure, sameSite };
}
