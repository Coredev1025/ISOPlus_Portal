// Backend/src/utils/automationSettingsHelpers.js
import {
  AUTOMATION_UNITS,
  KIND_INVOICE,
  KIND_STATEMENT,
  MAX_EVERY_N,
  RUN_AT_PATTERN,
  WEEKDAYS,
} from '../constants/automation.js';
import { EMAIL_PATTERN } from '../constants/validation.js';
import { pickerScheduleError } from '../services/scheduler/pickerValidation.js';
import { SEND_METHODS, RECIPIENTS } from '../models/AutomationSettings.js';

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

/**
 * The `emailMessage` ceiling, in characters.
 *
 * It is rich-text HTML that gets emailed to clients, and before this it was
 * validated by nothing at all: an unbounded string went into Mongo, back out
 * on every GET, and into an outgoing email. 20k characters is far more than
 * any covering note needs and far less than a document that would break the
 * mail path.
 *
 * Read by validateBlock below and by the tests. CLAUDE.md wants it in
 * constants/automation.js — see the follow-up note in the PR; that file is
 * owned elsewhere on this branch.
 */
export const MAX_EMAIL_MESSAGE_LENGTH = 20000;

/**
 * What the client is told when the last run failed. Deliberately says nothing
 * about the failure: see buildAutomationSettingsPayload.
 */
const LAST_RUN_FAILED_MESSAGE = 'The last run failed. Check the automation logs for details.';

const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function validateRunOn(unit, runOn) {
  if (unit === 'day') return null;
  if (unit === 'week') {
    return WEEKDAYS.includes(String(runOn).toLowerCase())
      ? null
      : `runOn must be a weekday name when unit is "week"`;
  }
  if (unit === 'month') {
    // 1-31, per the spec's picker. Days 29-31 do not skip short months: the
    // scheduler clamps to the month's last day (automationScheduleHelpers.js
    // addMonthsClamped), so "the 31st" fires on 30 Apr and 28/29 Feb.
    return inRange(runOn, 1, 31)
      ? null
      : `runOn must be an integer between 1 and 31 when unit is "month"`;
  }
  // Same bounds as the month branch, for the same reason: an out-of-range
  // {month: 99, day: -3} is not rejected by the arithmetic, it is silently
  // clamped to some other date — so the picker would keep displaying a value
  // the schedule does not use.
  const ok = runOn && inRange(runOn.month, 1, 12) && inRange(runOn.day, 1, 31);
  return ok
    ? null
    : `runOn must be {month, day} with month 1-12 and day 1-31 when unit is "${unit}"`;
}

function validateEmails(block) {
  for (const field of ['sendCopyTo', 'replyTo', 'emailFrom']) {
    const value = block[field];
    if (value && !EMAIL_PATTERN.test(value)) return `${field} must be a valid email address`;
  }
  return null;
}

/**
 * The fields checked whatever `enabled` says. They are stored exactly as sent
 * and used the moment somebody re-enables the block, so accepting a malformed
 * address here only defers the failure to the first send — and no client has
 * a reason to send one.
 */
function validateContent(block) {
  const emailError = validateEmails(block);
  if (emailError) return emailError;
  if (String(block.emailMessage ?? '').length > MAX_EMAIL_MESSAGE_LENGTH) {
    return `emailMessage must be ${MAX_EMAIL_MESSAGE_LENGTH} characters or fewer`;
  }
  return null;
}

/** The cadence fields, which only have to make sense for a block that runs. */
function validateSchedule(block) {
  const { unit, n } = block.every ?? {};
  if (!AUTOMATION_UNITS.includes(unit)) {
    return `every.unit must be one of ${AUTOMATION_UNITS.join(', ')}`;
  }
  if (!Number.isInteger(n) || n < 1) return 'every.n must be a positive integer';
  if (n > MAX_EVERY_N) return `every.n must be ${MAX_EVERY_N} or less`;
  if (!RUN_AT_PATTERN.test(String(block.runAt ?? ''))) return 'runAt must be HH:MM';
  if (!SEND_METHODS.includes(block.sendMethod)) return 'invalid sendMethod';
  if (!RECIPIENTS.includes(block.recipient)) return 'invalid recipient';
  return validateRunOn(unit, block.runOn);
}

function validateBlock(name, block) {
  const contentError = validateContent(block);
  if (contentError) return `${name}: ${contentError}`;

  // A disabled block's cadence is not validated: a client who turns automation
  // off should not be blocked by a field they are no longer using.
  if (!block.enabled) return null;

  const scheduleError = validateSchedule(block);
  return scheduleError ? `${name}: ${scheduleError}` : null;
}

function mergeBlock(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_AUTOMATION_BLOCK };
  return {
    ...DEFAULT_AUTOMATION_BLOCK,
    ...input,
    every: { ...DEFAULT_AUTOMATION_BLOCK.every, ...(input.every ?? {}) },
  };
}

/**
 * Weekday names are stored lowercase, because that is the only case the rest
 * of the system uses: the scheduler lowercases before comparing, so "Friday"
 * fired correctly but round-tripped to the UI in a case nothing else matches.
 * Normalising on the write path keeps one spelling in the database.
 */
function normalizeBlock(block) {
  if (block.every?.unit !== 'week' || typeof block.runOn !== 'string') return block;
  return { ...block, runOn: block.runOn.toLowerCase() };
}

/**
 * PUT is a full replace: an absent `invoice` or `statement` is read as the
 * default block, not as "leave the stored one alone". That is what the only
 * client sends (Frontend/lib/automation-settings.ts PUTs the whole settings
 * object it just fetched), and it is what the route's disable-on-absent
 * behaviour already did — so it is documented and tested rather than changed.
 * A partial PUT therefore resets the omitted block and disables its schedule.
 */
export function parseAutomationSettingsBody(body) {
  const invoice = mergeBlock(body?.invoice);
  const statement = mergeBlock(body?.statement);

  const error = validateBlock('invoice', invoice) ?? validateBlock('statement', statement);
  if (error) return { error };

  return { value: { invoice: normalizeBlock(invoice), statement: normalizeBlock(statement) } };
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
 * The two blocks in the order the route writes them, paired with the
 * `ScheduledJob.kind` each becomes.
 */
export function automationScheduleBlocks(value) {
  return [
    { kind: KIND_INVOICE, block: value.invoice },
    { kind: KIND_STATEMENT, block: value.statement },
  ];
}

/**
 * Every enabled block's schedule, checked against the same validator
 * `upsertSchedule` applies — before any of them is written.
 *
 * The route writes the invoice schedule and then the statement one, so a body
 * whose second block was rejected used to leave the first live on its new
 * cadence, `AutomationSettings` holding the old values, and the client told
 * 400. Nothing about that state announces itself: the schedule fires, and the
 * page shows the settings it did not save. Validating both up front removes
 * the only body-driven route to it. (A database failure between the two
 * writes can still produce it, and that is a 500 — see the route.)
 *
 * The message is the one upsertSchedule would have thrown, prefix included,
 * so the client sees the same text whichever check catches the body.
 */
export function automationScheduleRejection(value) {
  for (const { kind, block } of automationScheduleBlocks(value)) {
    if (!block.enabled) continue;
    const invalid = pickerScheduleError(toScheduleInput(block));
    if (invalid) return `Scheduler: invalid schedule for "${kind}" — ${invalid}`;
  }
  return null;
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
  const shape = (block, kind) => {
    const job = jobs[kind];
    return {
      ...DEFAULT_AUTOMATION_BLOCK,
      ...(block ?? {}),
      // A paused schedule keeps its row (and history), but must not advertise
      // a next run that will never fire — hence the enabled check. Jobs from
      // callers that never select `enabled` are treated as enabled.
      nextRun: job && job.enabled !== false ? (job.nextRunAt ?? null) : null,
      lastRunAt: job?.lastRunAt ?? null,
      // Never the stored string. ScheduledJob.lastError stringifies whatever
      // the run threw, so it carries database and index names (E11000 ...
      // business-dashboard.pdflinks index), internal addressing (connect
      // ECONNREFUSED 10.x.x.x:6379), bucket names, and — for a non-Error throw
      // — a JSON.stringify of the whole object, which for anything
      // config-shaped is credential-shaped. The client gets the fact of the
      // failure; the detail stays in the logs.
      //
      // `lastRunError` keeps its name and stays a non-empty string on failure
      // because the status panel reads it as the "attention needed" signal
      // (Frontend/lib/automation-status-panel.tsx never renders the text).
      // `lastRunFailed` is the same signal, said plainly, for new callers.
      lastRunFailed: Boolean(job?.lastError),
      lastRunError: job?.lastError ? LAST_RUN_FAILED_MESSAGE : null,
    };
  };

  return {
    invoice: shape(settings?.invoice, 'invoice_automation'),
    statement: shape(settings?.statement, 'statement_automation'),
  };
}
