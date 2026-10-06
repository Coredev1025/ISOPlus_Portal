import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function safeEqualStrings(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** RFC 7636 PKCE S256 pair for the Google authorize → token exchange. */
export function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/**
 * Bind the OAuth callback to the same browser session that started login.
 * Prevents login CSRF via a stolen authorization code + attacker state.
 */
export function verifyPkceSessionBinding({
  returnedState,
  sessionState,
  sessionVerifier,
}) {
  if (!returnedState || typeof returnedState !== 'string') {
    return { ok: false, reason: 'state_missing' };
  }
  if (!sessionState || !sessionVerifier) {
    return { ok: false, reason: 'session_missing' };
  }
  if (!safeEqualStrings(returnedState, sessionState)) {
    return { ok: false, reason: 'state_mismatch' };
  }
  return { ok: true, verifier: sessionVerifier };
}
