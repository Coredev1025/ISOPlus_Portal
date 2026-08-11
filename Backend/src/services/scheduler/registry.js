/**
 * Delivery policy is declared here, at registration, rather than stored on the
 * schedule record — an operator editing a record must not be able to put a
 * handler under a guarantee it cannot survive.
 *
 * AT_MOST_ONCE  the schedule advances as part of the claim, before dispatch.
 *               A crash loses the slot. Correct where a duplicate is worse
 *               than a miss: issuing an invoice.
 * AT_LEAST_ONCE the schedule advances only after a successful enqueue. A crash
 *               retries the slot, and two instances may both dispatch.
 *               Correct where the handler is idempotent and a miss is worse
 *               than a repeat: board sync.
 */
export const AT_MOST_ONCE = 'at_most_once';
export const AT_LEAST_ONCE = 'at_least_once';

const POLICIES = new Set([AT_MOST_ONCE, AT_LEAST_ONCE]);

const handlers = new Map();

export function register(kind, { handler, policy } = {}) {
  if (typeof handler !== 'function') {
    throw new Error(`Scheduler: handler for "${kind}" must be a function`);
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

export function registeredKinds() {
  return [...handlers.keys()];
}

/** Test seam. Never call this from application code. */
export function clearRegistry() {
  handlers.clear();
}
