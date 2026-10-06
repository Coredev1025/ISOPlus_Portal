import { describe, it, expect } from 'vitest';
import {
  parseFinanceSettingsTab,
  resolveActiveFinanceTab,
} from '@/lib/finance-settings-tab';

// Epic 1 (KAN-6): tab query parsing + automation tab gating by workspace flag.

describe('parseFinanceSettingsTab (Epic 1 / KAN-6)', () => {
  it('defaults to financial for missing or unknown values', () => {
    expect(parseFinanceSettingsTab(null)).toBe('financial');
    expect(parseFinanceSettingsTab(undefined)).toBe('financial');
    expect(parseFinanceSettingsTab('')).toBe('financial');
    expect(parseFinanceSettingsTab('unknown')).toBe('financial');
    expect(parseFinanceSettingsTab('AUTOMATION')).toBe('financial');
  });

  it('accepts known tab ids', () => {
    expect(parseFinanceSettingsTab('financial')).toBe('financial');
    expect(parseFinanceSettingsTab('accounting')).toBe('accounting');
    expect(parseFinanceSettingsTab('automation')).toBe('automation');
  });
});

describe('resolveActiveFinanceTab (Epic 1 / KAN-6)', () => {
  it('allows automation only when the workspace flag is enabled', () => {
    expect(resolveActiveFinanceTab('automation', 'on')).toBe('automation');
    expect(resolveActiveFinanceTab('automation', 'off')).toBe('financial');
  });

  /**
   * Only a definite "off" redirects. When the profile call did not answer we
   * do not know whether the workspace has the feature, and silently sending
   * the reader to Financial Settings tells them it does not.
   *
   * Keeping them on the tab is safe because the server, not this function, is
   * the gate: GET /automation-settings is deliberately open so a workspace
   * that lost the feature can still see what it had, and PUT answers 403.
   * The worst case is a panel that reports its own error, which is honest.
   */
  it('keeps automation when the flag could not be determined', () => {
    expect(resolveActiveFinanceTab('automation', 'unavailable')).toBe('automation');
  });

  it('leaves other tabs unchanged regardless of flag', () => {
    for (const state of ['on', 'off', 'unavailable'] as const) {
      expect(resolveActiveFinanceTab('financial', state)).toBe('financial');
      expect(resolveActiveFinanceTab('accounting', state)).toBe('accounting');
    }
  });
});
