// Backend/test/unit/utils/automationSettingsHelpers.test.js
import { describe, it, expect } from 'vitest';
import {
  parseAutomationSettingsBody,
  buildAutomationSettingsPayload,
  DEFAULT_AUTOMATION_BLOCK,
  MAX_EMAIL_MESSAGE_LENGTH,
  automationScheduleRejection,
} from '../../../src/utils/automationSettingsHelpers.js';
import { DEFAULT_TIMEZONE } from '../../../src/constants/scheduler.js';

const validBlock = {
  enabled: true,
  every: { n: 2, unit: 'week' },
  runOn: 'monday',
  runAt: '09:00',
  startDate: '2026-03-01',
  sendMethod: 'isoplus',
  recipient: 'billing_contact',
  sendCopyTo: 'a@b.com',
  replyTo: 'c@d.com',
};

describe('parseAutomationSettingsBody', () => {
  it('accepts a valid weekly block', () => {
    const result = parseAutomationSettingsBody({ invoice: validBlock });
    expect(result.error).toBeUndefined();
    expect(result.value.invoice.every.unit).toBe('week');
  });

  it('rejects an unknown unit', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'fortnight' } },
    });
    expect(result.error).toMatch(/unit/);
  });

  it('rejects a weekday runOn when the unit is month', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'month' }, runOn: 'monday' },
    });
    expect(result.error).toMatch(/runOn/);
  });

  it('accepts a month runOn of 31', () => {
    // The spec offers 1st-31st; the scheduler clamps 29-31 to short months
    // (automationScheduleHelpers.addMonthsClamped), so no month is skipped.
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'month' }, runOn: 31 },
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects a month runOn above 31', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'month' }, runOn: 32 },
    });
    expect(result.error).toMatch(/runOn/);
  });

  it('rejects a malformed runAt', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, runAt: '9am' },
    });
    expect(result.error).toMatch(/runAt/);
  });

  it('rejects a malformed sendCopyTo', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, sendCopyTo: 'not-an-email' },
    });
    expect(result.error).toMatch(/sendCopyTo/);
  });

  // Three people need the automated mail — the developer, the account manager
  // and the reviewer — and one field held one address, so a run could copy
  // exactly one of them. Only this field takes a list: Reply-to and Email From
  // each name a single mailbox by definition.
  it('accepts several comma-separated addresses in sendCopyTo', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, sendCopyTo: 'a@b.com, c@d.com,e@f.com' },
    });
    expect(result.error).toBeUndefined();
    expect(result.value.invoice.sendCopyTo).toBe('a@b.com, c@d.com,e@f.com');
  });

  it('rejects a list where any one address is malformed', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, sendCopyTo: 'a@b.com, not-an-email' },
    });
    expect(result.error).toMatch(/sendCopyTo/);
  });

  // A trailing comma leaves an empty address, which would reach SES as a blank
  // recipient rather than being ignored.
  it('rejects a trailing comma', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, sendCopyTo: 'a@b.com,' },
    });
    expect(result.error).toMatch(/sendCopyTo/);
  });

  // Reply-to names the mailbox a client's reply goes to; a list there is a
  // mistake, not a feature.
  it('still rejects a list in replyTo', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, replyTo: 'a@b.com, c@d.com' },
    });
    expect(result.error).toMatch(/replyTo/);
  });

  it('applies defaults for a missing block', () => {
    const result = parseAutomationSettingsBody({ invoice: validBlock });
    expect(result.value.statement).toEqual(DEFAULT_AUTOMATION_BLOCK);
  });

  it('does not validate schedule fields of a disabled block', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, enabled: false, runAt: 'nonsense' },
    });
    expect(result.error).toBeUndefined();
  });

  it('accepts a valid {month, day} runOn shape for unit quarter', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'quarter' }, runOn: { month: 1, day: 15 } },
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects a quarter runOn that is not a {month, day} shape', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'quarter' }, runOn: 'monday' },
    });
    expect(result.error).toMatch(/runOn/);
  });

  it('accepts a valid {month, day} runOn shape for unit year', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'year' }, runOn: { month: 3, day: 20 } },
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects a year runOn that is not a {month, day} shape', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'year' }, runOn: 5 },
    });
    expect(result.error).toMatch(/runOn/);
  });

  it('rejects a non-weekday runOn when the unit is week', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'week' }, runOn: 3 },
    });
    expect(result.error).toMatch(/runOn/);
  });

  it('rejects a non-integer every.n', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1.5, unit: 'week' } },
    });
    expect(result.error).toMatch(/every\.n/);
  });

  it('rejects an every.n less than 1', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 0, unit: 'week' } },
    });
    expect(result.error).toMatch(/every\.n/);
  });

  it('accepts an every.n of 365', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 365, unit: 'day' } },
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects an every.n above 365', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 366, unit: 'day' } },
    });
    expect(result.error).toMatch(/every\.n/);
  });

  it('rejects an invalid sendMethod', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, sendMethod: 'paypal' },
    });
    expect(result.error).toMatch(/sendMethod/);
  });

  it('rejects an invalid recipient', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, recipient: 'nobody' },
    });
    expect(result.error).toMatch(/recipient/);
  });

  it('ignores runOn for a day-unit block', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'day' }, runOn: 'nonsense-value' },
    });
    expect(result.error).toBeUndefined();
  });

  it('rejects a malformed replyTo', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, replyTo: 'not-an-email' },
    });
    expect(result.error).toMatch(/replyTo/);
  });

  it('rejects a malformed emailFrom', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, emailFrom: 'not-an-email' },
    });
    expect(result.error).toMatch(/emailFrom/);
  });

  // Commit ceaefe3 bounded the integer branch (unit month) and missed this
  // one. {month: 99, day: -3} was accepted, stored, echoed back on GET, and
  // then silently clamped by the schedule arithmetic — so what the picker
  // displayed and what the schedule did disagreed permanently.
  describe('quarter/year runOn bounds', () => {
    const quarter = (runOn) =>
      parseAutomationSettingsBody({
        invoice: { ...validBlock, every: { n: 1, unit: 'quarter' }, runOn },
      });

    it('accepts the extremes of the picker range', () => {
      expect(quarter({ month: 1, day: 1 }).error).toBeUndefined();
      expect(quarter({ month: 12, day: 31 }).error).toBeUndefined();
    });

    it('rejects a month outside 1-12', () => {
      expect(quarter({ month: 99, day: 3 }).error).toMatch(/runOn/);
      expect(quarter({ month: 0, day: 3 }).error).toMatch(/runOn/);
    });

    it('rejects a day outside 1-31', () => {
      expect(quarter({ month: 3, day: -3 }).error).toMatch(/runOn/);
      expect(quarter({ month: 3, day: 32 }).error).toMatch(/runOn/);
    });

    it('applies the same bounds to unit year', () => {
      const result = parseAutomationSettingsBody({
        invoice: { ...validBlock, every: { n: 1, unit: 'year' }, runOn: { month: 13, day: 1 } },
      });
      expect(result.error).toMatch(/runOn/);
    });
  });

  describe('emailMessage', () => {
    it('accepts a message at the maximum length', () => {
      const result = parseAutomationSettingsBody({
        invoice: { ...validBlock, emailMessage: 'x'.repeat(MAX_EMAIL_MESSAGE_LENGTH) },
      });
      expect(result.error).toBeUndefined();
    });

    it('rejects a message above the maximum length', () => {
      // Rich-text HTML that gets emailed to clients, previously validated by
      // nothing at all and stored unbounded.
      const result = parseAutomationSettingsBody({
        invoice: { ...validBlock, emailMessage: 'x'.repeat(MAX_EMAIL_MESSAGE_LENGTH + 1) },
      });
      expect(result.error).toMatch(/emailMessage/);
    });

    it('caps the message on a disabled block too', () => {
      const result = parseAutomationSettingsBody({
        invoice: {
          ...validBlock,
          enabled: false,
          emailMessage: 'x'.repeat(MAX_EMAIL_MESSAGE_LENGTH + 1),
        },
      });
      expect(result.error).toMatch(/emailMessage/);
    });
  });

  // The schedule fields of a disabled block are deliberately unvalidated — a
  // half-filled cadence must not block turning automation off. The address
  // fields are a different case: they are stored as sent and used the moment
  // somebody re-enables the block, and no client has a reason to send an
  // invalid one, so they are checked whatever `enabled` says.
  it('validates the address fields of a disabled block', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, enabled: false, replyTo: 'not-an-email' },
    });
    expect(result.error).toMatch(/replyTo/);
  });

  it('lowercases a weekday runOn on the write path', () => {
    // The scheduler lowercases when it compares, so "Friday" fired correctly
    // but round-tripped to the UI in a case nothing else in the system uses.
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'week' }, runOn: 'Friday' },
    });
    expect(result.error).toBeUndefined();
    expect(result.value.invoice.runOn).toBe('friday');
  });
});

describe('automationScheduleRejection', () => {
  const enabled = (overrides) => ({
    ...validBlock,
    every: { n: 1, unit: 'month' },
    runOn: 1,
    ...overrides,
  });

  it('passes when every enabled block would be accepted by the scheduler', () => {
    const value = { invoice: enabled(), statement: { ...enabled(), enabled: false } };
    expect(automationScheduleRejection(value)).toBeNull();
  });

  it('names the second block, so it is caught before the first is written', () => {
    const value = {
      invoice: enabled(),
      statement: enabled({ startDate: 'not-a-date' }),
    };
    const rejection = automationScheduleRejection(value);
    expect(rejection).toMatch(/statement_automation/);
    expect(rejection).toMatch(/startDate/);
    // The prefix isScheduleClientError keys on, and the same text
    // upsertSchedule would have thrown had it got that far.
    expect(rejection.startsWith('Scheduler: ')).toBe(true);
  });

  it('ignores a disabled block, which is never written as a schedule', () => {
    const value = {
      invoice: enabled(),
      statement: enabled({ enabled: false, startDate: 'not-a-date' }),
    };
    expect(automationScheduleRejection(value)).toBeNull();
  });
});

describe('buildAutomationSettingsPayload', () => {
  /**
   * `nextRun` and `lastRunAt` are instants; `runAt` is a wall-clock time in the
   * schedule's own zone. Without the zone travelling beside them the client can
   * only format an instant in the reader's timezone, which put two different
   * clocks in one row — a 09:00 Sydney schedule reading "7:00 AM" in Manila.
   *
   * ScheduledJob.timezone is the value the tick actually computes on, so it is
   * the only correct source; it is not `Business.headOfficeTimezone` read a
   * second time, which may have changed since the schedule was written.
   */
  it('carries the schedule timezone so instants can be formatted in it', () => {
    const payload = buildAutomationSettingsPayload(
      { invoice: { enabled: true }, statement: { enabled: true } },
      {
        invoice_automation: { timezone: 'Australia/Perth' },
        statement_automation: { timezone: 'Pacific/Auckland' },
      },
    );

    expect(payload.invoice.timezone).toBe('Australia/Perth');
    expect(payload.statement.timezone).toBe('Pacific/Auckland');
  });

  it('falls back to the default timezone when no job carries one', () => {
    // A block that has never been enabled has no ScheduledJob row at all, and
    // a legacy row may predate the field. Both must still format.
    const payload = buildAutomationSettingsPayload(
      { invoice: { enabled: false }, statement: { enabled: false } },
      { statement_automation: { lastRunAt: new Date('2026-08-01T23:00:00.000Z') } },
    );

    expect(payload.invoice.timezone).toBe(DEFAULT_TIMEZONE);
    expect(payload.statement.timezone).toBe(DEFAULT_TIMEZONE);
  });

  /**
   * A paused block hides its nextRun but keeps its history, so the zone that
   * history is read in has to survive the pause too.
   */
  it('keeps the timezone on a paused block, unlike nextRun', () => {
    const payload = buildAutomationSettingsPayload(
      { invoice: { enabled: false } },
      {
        invoice_automation: {
          enabled: false,
          timezone: 'Australia/Perth',
          nextRunAt: new Date('2026-09-01T23:00:00.000Z'),
          lastRunAt: new Date('2026-08-01T23:00:00.000Z'),
        },
      },
    );

    expect(payload.invoice.nextRun).toBeNull();
    expect(payload.invoice.timezone).toBe('Australia/Perth');
  });

  it('merges nextRunAt from the linked job as read-only nextRun', () => {
    const when = new Date('2026-08-12T09:00:00+10:00');
    const payload = buildAutomationSettingsPayload(
      { invoice: { enabled: true }, statement: { enabled: false } },
      { invoice_automation: { nextRunAt: when } },
    );
    expect(payload.invoice.nextRun).toEqual(when);
    expect(payload.statement.nextRun).toBeNull();
  });

  it('surfaces the last run and its outcome per block', () => {
    const ranAt = new Date('2026-08-01T23:00:00.000Z');
    const payload = buildAutomationSettingsPayload(
      { invoice: { enabled: true }, statement: { enabled: true } },
      {
        invoice_automation: {
          nextRunAt: new Date('2026-09-01T23:00:00.000Z'),
          lastRunAt: ranAt,
          lastError: null,
          consecutiveFailures: 0,
        },
        statement_automation: {
          lastRunAt: ranAt,
          lastError: 'generator exploded',
          consecutiveFailures: 2,
        },
      },
    );
    expect(payload.invoice.lastRunAt).toEqual(ranAt);
    expect(payload.invoice.lastRunError).toBeNull();
    expect(payload.invoice.lastRunFailed).toBe(false);
    expect(payload.statement.lastRunAt).toEqual(ranAt);
    expect(payload.statement.lastRunFailed).toBe(true);
  });

  // ScheduledJob.lastError stringifies whatever the run threw, so it carries
  // database and index names (E11000 ... business-dashboard.pdflinks index),
  // internal addressing (connect ECONNREFUSED 10.x.x.x:6379), bucket names,
  // and — for a non-Error throw — a JSON.stringify of the whole object, which
  // for anything config-shaped is credential-shaped. None of that belongs in
  // an API response; the raw string stays in the logs.
  it('does not pass the stored lastError through to the client', () => {
    const payload = buildAutomationSettingsPayload(
      { invoice: { enabled: true } },
      {
        invoice_automation: {
          lastRunAt: new Date('2026-08-01T23:00:00.000Z'),
          lastError:
            'E11000 duplicate key error collection: business-dashboard.pdflinks index: pdfLink_1',
        },
      },
    );

    expect(payload.invoice.lastRunFailed).toBe(true);
    expect(payload.invoice.lastRunError).not.toMatch(/E11000|business-dashboard|pdflinks/);
    // The field keeps its name and stays a non-empty string, because the
    // status panel treats it as the "this run failed" signal.
    expect(typeof payload.invoice.lastRunError).toBe('string');
    expect(payload.invoice.lastRunError.length).toBeGreaterThan(0);
  });

  it('keeps lastRunAt visible for a disabled job while hiding its nextRun', () => {
    // disableSchedule keeps the row (and its history) with enabled: false; a
    // paused block still shows when it last ran, but must not advertise a
    // next run that will never fire.
    const ranAt = new Date('2026-07-01T23:00:00.000Z');
    const payload = buildAutomationSettingsPayload(
      { invoice: { enabled: false } },
      {
        invoice_automation: {
          enabled: false,
          nextRunAt: new Date('2026-08-01T23:00:00.000Z'),
          lastRunAt: ranAt,
        },
      },
    );
    expect(payload.invoice.nextRun).toBeNull();
    expect(payload.invoice.lastRunAt).toEqual(ranAt);
  });
});
