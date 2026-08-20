/**
 * The tick's recipient override.
 *
 * A scheduled run resolves each document's recipient from the participant's
 * profile — the Billing Email, or the participant's own address. That is
 * correct in production and useless for verifying a deployment, because the
 * only way to prove the delivery path works is to send, and sending means
 * sending to a participant.
 *
 * `bypassEmail` replaces the resolved recipient for the whole tick. Everything
 * else runs untouched: the same selection, the same generation, the same
 * composition and the same attachments. Only the destination changes, so what
 * is proved is the real path rather than a simulation of it.
 *
 * ## Why a malformed value throws
 *
 * The failure mode this guards against is a typo. If a bad address were simply
 * dropped, the run would fall back to the real billing contacts — which is the
 * precise outcome the parameter exists to prevent, arriving silently and
 * irreversibly. So anything that does not parse to at least one well-formed
 * address fails the tick instead.
 */

// Deliberately the same shape used by services/email/recipients.js, so an
// address this accepts is one the send path also considers valid. A stricter
// pattern here would reject addresses the resolver would have sent to; a looser
// one would let the override through and fail later, at send time, after the
// documents were already generated.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalise a `bypassEmail` input into a list of addresses, or null.
 *
 * Accepts a comma-separated string or an array of strings. Null means "not
 * supplied" — the caller then resolves recipients normally.
 *
 * @param {string|string[]|null|undefined} value
 * @returns {string[]|null}
 */
export function parseBypassEmail(value) {
  if (value === undefined || value === null) return null;

  let parts;
  if (Array.isArray(value)) {
    parts = value;
  } else if (typeof value === 'string') {
    if (!value.trim()) return null;
    parts = value.split(',');
  } else {
    throw new Error('bypassEmail must be a comma-separated string or an array of addresses');
  }

  const addresses = [];
  const seen = new Set();
  for (const part of parts) {
    const address = String(part ?? '').trim();
    // An empty entry is a trailing or doubled comma, not a typo — skipping it
    // cannot redirect mail anywhere, so it does not warrant failing the tick.
    if (!address) continue;
    if (!EMAIL_PATTERN.test(address)) {
      throw new Error(`bypassEmail: '${address}' is not a valid email address`);
    }
    // One mailbox gets one copy, whatever case it was typed in. The first
    // spelling wins, so the address is reported back as the operator wrote it.
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }

  return addresses.length > 0 ? addresses : null;
}
