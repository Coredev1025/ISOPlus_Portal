/**
 * Delivery policy is declared at registration rather than stored on the
 * schedule record — an operator editing a record must not be able to put a
 * handler under a guarantee it cannot survive. The two policy values live in
 * constants/scheduler.js; what they mean is documented there.
 */
import { AT_MOST_ONCE, AT_LEAST_ONCE } from '../../constants/scheduler.js';

// Derived from the two constants rather than a third list of policy names,
// so adding a policy cannot leave the validator behind.
const POLICIES = new Set([AT_MOST_ONCE, AT_LEAST_ONCE]);

const handlers = new Map();

export function register(kind, { handler, policy } = {}) {
  if (typeof handler !== 'function') {
    throw new TypeError(`Scheduler: handler for "${kind}" must be a function`);
  }
  if (!POLICIES.has(policy)) {
    throw new Error(
      `Scheduler: handler for "${kind}" must declare a policy of ` +
        `"${AT_MOST_ONCE}" or "${AT_LEAST_ONCE}"`,
    );
  }
  if (handlers.has(kind)) {
    throw new Error(`Scheduler: kind "${kind}" is already registered`);
  }

  handlers.set(kind, { handler, policy });
}

export function resolve(kind) {
  const entry = handlers.get(kind);
  if (!entry) {
    throw new Error(`Scheduler: kind "${kind}" is not registered`);
  }
  return entry;
}

/**
 * Same lookup as resolve(), but returns null for an unregistered kind rather
 * than throwing. For callers — the minimum-interval floor is the current
 * one — that can legitimately run before a handler is registered in this
 * process (a test, a script) and must not be blocked by that.
 */
export function tryResolve(kind) {
  return handlers.get(kind) ?? null;
}

/** Test seam. Never call this from application code. */
export function clearRegistry() {
  handlers.clear();
}
