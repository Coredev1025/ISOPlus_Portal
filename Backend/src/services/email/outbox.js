// The delivery seam. Composing a message and delivering it are separate
// concerns here: `deliverEmail` decides WHICH backend this environment has and
// hands the message over, and the backend decides what delivery means —
// writing a readable preview offline, or an SES SMTP send online.
//
// Adding a provider is a registration (services/email/registry.js), not an
// edit to this file or to the worker.

import { info, warn } from '../../utils/logger.js';
import { localOutboxBackend, sesBackend } from './backends.js';
import { isEmailTransportConfigured } from './sesTransport.js';
import { isOfflineMode } from '../offlineIsoplus.js';
import {
  LOCAL_OUTBOX_BACKEND,
  SES_BACKEND,
  clearEmailBackends,
  registerEmailBackend,
  resolveEmailBackend,
  selectBackendName,
} from './registry.js';

export { outboxKeyFor } from './backends.js';

let registered = false;

/**
 * Idempotent because the worker, a route and a test can each be the first
 * caller in a process, and re-registering a name is deliberately an error.
 */
export function registerBuiltInEmailBackends() {
  if (registered) return;
  registerEmailBackend(LOCAL_OUTBOX_BACKEND, localOutboxBackend);
  registerEmailBackend(SES_BACKEND, sesBackend);
  registered = true;
}

/** Test seam: forget the built-ins so a suite can register its own. */
export function resetEmailBackends() {
  clearEmailBackends();
  registered = false;
}

/**
 * Whether this environment can deliver at all, and how.
 *
 * The worker asks BEFORE generating: generation claims invoice numbers and
 * writes PDFLink rows, so discovering there is no transport afterwards burns
 * real numbers on documents nobody receives.
 */
export function activeEmailBackendName({ from = null } = {}) {
  return selectBackendName({
    offline: isOfflineMode(),
    transportConfigured: isEmailTransportConfigured({ from }),
  });
}

/**
 * Deliver a composed automation email.
 *
 * `block` is the email half of an AutomationSettings block, already validated
 * by parseAutomationSettingsBody. The recipient is stored as a *type*
 * (billing_contact | client_participant); the SES backend resolves it to a
 * real address, and the offline one records the type it would resolve.
 */
export async function deliverEmail(message) {
  registerBuiltInEmailBackends();

  const name = activeEmailBackendName({ from: message?.block?.emailFrom ?? null });
  if (!name) {
    // Louder than a silent skip: an environment that is online with no
    // transport can neither send nor usefully pretend to.
    throw new Error(
      'Email delivery is not configured: set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY ' +
      "and AWS_REGION, give the workspace an Email From (or set EMAIL_FROM as the " +
      'default), or run offline to write outbox previews instead.',
    );
  }

  const backend = resolveEmailBackend(name);
  const result = await backend.deliver(message);

  if (result.delivered === false && result.reason) {
    warn('Email-Delivery', 'Backend delivered nothing', {
      backend: name, kind: message.kind, reason: result.reason,
    });
  } else {
    info('Email-Delivery', 'Message handed to backend', {
      backend: name, kind: message.kind, delivered: result.delivered === true,
    });
  }
  return result;
}
