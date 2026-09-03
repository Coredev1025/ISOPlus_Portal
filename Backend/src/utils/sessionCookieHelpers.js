/**
 * Session cookie flags for express-session.
 *
 * Touchpoints: src/app.js, src/index.js
 *
 * Frontend (localhost) + API (ngrok HTTPS) is cross-site: browsers only store/
 * send the session on XHR when SameSite=None and Secure. Production already
 * needs that for portal ↔ API split origins. Local http://localhost backends
 * keep SameSite=lax.
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
