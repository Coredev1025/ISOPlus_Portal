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

  it('rejects a month runOn above 28', () => {
    const result = parseAutomationSettingsBody({
      invoice: { ...validBlock, every: { n: 1, unit: 'month' }, runOn: 31 },
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
