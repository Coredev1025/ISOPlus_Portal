/**
 * Which backend actually delivers an automation email.
 *
 * A backend is anything with `deliver(composed, message)`. Registration is by
 * name, mirroring services/scheduler/registry.js, so adding one — a different
 * provider, a queue, a capture backend for a demo — is a registration rather
 * than an edit to the caller. `deliverEmail` never learns their names.
 *
 * The two that ship: `local-outbox` writes the composed message to the offline
 * store and logs it, and `ses` sends it over SES SMTP.
 */

const backends = new Map();

export const LOCAL_OUTBOX_BACKEND = 'local-outbox';
export const SES_BACKEND = 'ses';

export function registerEmailBackend(name, backend) {
  if (typeof backend?.deliver !== 'function') {
    throw new TypeError(`Email: backend "${name}" must expose deliver()`);
  }
  if (backends.has(name)) {
    // Silently replacing one would let whatever loads last redirect every
    // customer email.
    throw new Error(`Email: backend "${name}" is already registered`);
  }
  backends.set(name, backend);
}

export function resolveEmailBackend(name) {
  const backend = backends.get(name);
  if (!backend) {
    throw new Error(`Email: backend "${name}" is not registered`);
  }
  return backend;
}

/**
 * The backend this environment should use, or null when there is no way to
 * deliver at all.
 *
 * Null is a real answer, not an error: the automation worker checks it BEFORE
 * generating, because generation claims invoice numbers and writes PDFLink
 * rows. Falling back to a file that nobody reads while a client waits for an
 * invoice is the failure this seam exists to avoid.
 *
 * `EMAIL_BACKEND` overrides both, so a newly registered backend needs no
 * change here.
 */
export function selectBackendName({ offline, transportConfigured } = {}) {
  const override = String(process.env.EMAIL_BACKEND ?? '').trim();
  if (override) return override;
  if (offline) return LOCAL_OUTBOX_BACKEND;
  return transportConfigured ? SES_BACKEND : null;
}

/** Test seam. Never call this from application code. */
export function clearEmailBackends() {
  backends.clear();
}
