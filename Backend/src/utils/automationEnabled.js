// The deployment-level kill switch for the invoice/statement automation
// pipeline, in one place because two layers read it: the scheduler tick, which
// decides whether an automation schedule may be claimed at all, and
// services/scheduler/handlers.js, which refuses to fan out. Two copies of this
// predicate is how the two come to disagree.

// An allow-list: anything else — unset, '', 'false', a typo — is off, because
// guessing wrong in the permissive direction consumes a customer's invoice
// numbers on mail nobody can send.
const AUTOMATION_ENABLED_VALUES = new Set(['true', '1', 'yes', 'on']);

/**
 * Read per call rather than at boot, so a change does not need a restart and
 * the refusal can name the kind and the workspace.
 */
export function isAutomationEnabled() {
  return AUTOMATION_ENABLED_VALUES.has(
    String(process.env.AUTOMATION_ENABLED ?? '').trim().toLowerCase(),
  );
}
