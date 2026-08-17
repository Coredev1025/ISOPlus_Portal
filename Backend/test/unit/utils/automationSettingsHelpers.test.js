// Backend/test/unit/utils/automationSettingsHelpers.test.js
import { describe, it, expect } from 'vitest';
import {
  parseAutomationSettingsBody,
  buildAutomationSettingsPayload,
  DEFAULT_AUTOMATION_BLOCK,
} from '../../../src/utils/automationSettingsHelpers.js';

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
});

describe('buildAutomationSettingsPayload', () => {
  it('merges nextRunAt from the linked job as read-only nextRun', () => {
    const when = new Date('2026-08-12T09:00:00+10:00');
    const payload = buildAutomationSettingsPayload(
      { invoice: { enabled: true }, statement: { enabled: false } },
      { invoice_automation: { nextRunAt: when } },
    );
    expect(payload.invoice.nextRun).toEqual(when);
    expect(payload.statement.nextRun).toBeNull();
  });

});
