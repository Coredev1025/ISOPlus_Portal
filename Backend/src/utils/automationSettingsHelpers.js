// Backend/src/utils/automationSettingsHelpers.js
import {
  AUTOMATION_UNITS,
  SEND_METHODS,
  RECIPIENTS,
} from '../models/AutomationSettings.js';

export const DEFAULT_AUTOMATION_BLOCK = {
  enabled: false,
  every: { n: 1, unit: 'month' },
  runOn: 1,
  runAt: '09:00',
  startDate: null,
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
  sendCopyTo: '',
  replyTo: '',
  emailFrom: '',
  emailSubject: '',
  emailMessage: '',
  senderIdentityId: null,
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const RUN_AT = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Deliberately loose: a full RFC 5322 check rejects addresses that work. The
// authoritative check is SES rejecting it at send time.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRunOn(unit, runOn) {
  if (unit === 'day') return null;
  if (unit === 'week') {
    return WEEKDAYS.includes(String(runOn).toLowerCase())
      ? null
      : `runOn must be a weekday name when unit is "week"`;
  }
  if (unit === 'month') {
    // 1-28 only: a schedule on the 29th-31st silently skips short months,
    // which for invoicing means a client is simply not billed that month.
    return Number.isInteger(runOn) && runOn >= 1 && runOn <= 28
      ? null
      : `runOn must be an integer between 1 and 28 when unit is "month"`;
  }
  const ok = runOn && Number.isInteger(runOn.month) && Number.isInteger(runOn.day);
  return ok ? null : `runOn must be {month, day} when unit is "${unit}"`;
}

function validateEmails(block) {
  for (const field of ['sendCopyTo', 'replyTo', 'emailFrom']) {
    const value = block[field];
    if (value && !EMAIL.test(value)) return `${field} must be a valid email address`;
  }
  return null;
}

function validateBlock(name, block) {
  // A disabled block is not validated: a client who turns automation off
  // should not be blocked by a field they are no longer using.
  if (!block.enabled) return null;

  const { unit, n } = block.every ?? {};
  if (!AUTOMATION_UNITS.includes(unit)) {
    return `${name}: every.unit must be one of ${AUTOMATION_UNITS.join(', ')}`;
  }
  if (!Number.isInteger(n) || n < 1) return `${name}: every.n must be a positive integer`;
  if (!RUN_AT.test(String(block.runAt ?? ''))) return `${name}: runAt must be HH:MM`;
  if (!SEND_METHODS.includes(block.sendMethod)) return `${name}: invalid sendMethod`;
  if (!RECIPIENTS.includes(block.recipient)) return `${name}: invalid recipient`;

  const runOnError = validateRunOn(unit, block.runOn);
  if (runOnError) return `${name}: ${runOnError}`;

  const emailError = validateEmails(block);
  return emailError ? `${name}: ${emailError}` : null;
}

function mergeBlock(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_AUTOMATION_BLOCK };
  return {
    ...DEFAULT_AUTOMATION_BLOCK,
    ...input,
    every: { ...DEFAULT_AUTOMATION_BLOCK.every, ...(input.every ?? {}) },
  };
}

export function parseAutomationSettingsBody(body) {
  const invoice = mergeBlock(body?.invoice);
  const statement = mergeBlock(body?.statement);

  const error = validateBlock('invoice', invoice) ?? validateBlock('statement', statement);
  if (error) return { error };

  return { value: { invoice, statement } };
}

/**
 * The `ScheduledJob.schedule` projection of a settings block.
 *
 * Pure: no clock and no I/O. Everything derived from this — the timezone and
 * `nextRunAt` — is the scheduler's to compute, so this is only the shape.
 * Callers pass a block that has already been through
 * `parseAutomationSettingsBody`, which is what guarantees `every` is present.
 */
export function toScheduleInput(block) {
  return {
    every: { n: block.every.n, unit: block.every.unit },
    runOn: block.runOn,
    runAt: block.runAt,
    startDate: block.startDate,
  };
}

/**
 * Is a failed schedule write the request body's fault rather than the
 * server's? Two families, and deliberately only two:
 *
 *   - everything `services/scheduler/schedules.js` refuses to write for — an
 *     invalid schedule, a timezone Intl does not recognise, both-or-neither
 *     of cron/schedule, a breach of the minimum interval. It throws all of
 *     them with a `Scheduler: ` prefix and throws nothing else.
 *   - a Mongoose `CastError`/`ValidationError`, which is a field the client
 *     sent in a type the schema cannot store — a `startDate` of
 *     `"not-a-date"` is the one the route can actually reach, because
 *     `parseAutomationSettingsBody` does not type-check that field.
 *
 * Anything else is a genuine server fault and has to stay a 500: a dropped
 * connection must not be reported back to the client as their mistake.
 */
export function isScheduleClientError(err) {
  if (err?.name === 'CastError' || err?.name === 'ValidationError') return true;
  return String(err?.message ?? '').startsWith('Scheduler: ');
}

/**
 * `nextRun` is never stored on AutomationSettings — ScheduledJob.nextRunAt is
 * the single source of truth, because it is the value the tick claims on.
 * This merges it in for display only.
 */
export function buildAutomationSettingsPayload(settings, jobs = {}) {
  const shape = (block, kind) => ({
    ...DEFAULT_AUTOMATION_BLOCK,
    ...(block ?? {}),
    nextRun: jobs[kind]?.nextRunAt ?? null,
  });

  return {
    invoice: shape(settings?.invoice, 'invoice_automation'),
    statement: shape(settings?.statement, 'statement_automation'),
  };
}
