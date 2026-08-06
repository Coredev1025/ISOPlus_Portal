import { describe, it, expect } from 'vitest';
import {
  parseFinanceSettingsTab,
  resolveActiveFinanceTab,
} from '@/lib/finance-settings-tab';

describe('parseFinanceSettingsTab', () => {
  it('defaults to financial for missing or unknown values', () => {
    expect(parseFinanceSettingsTab(null)).toBe('financial');
    expect(parseFinanceSettingsTab(undefined)).toBe('financial');
    expect(parseFinanceSettingsTab('')).toBe('financial');
    expect(parseFinanceSettingsTab('unknown')).toBe('financial');
  });

  it('accepts known tab ids', () => {
    expect(parseFinanceSettingsTab('financial')).toBe('financial');
    expect(parseFinanceSettingsTab('accounting')).toBe('accounting');
    expect(parseFinanceSettingsTab('automation')).toBe('automation');
  });
});

describe('resolveActiveFinanceTab', () => {
  it('allows automation only when the workspace flag is enabled', () => {
    expect(resolveActiveFinanceTab('automation', true)).toBe('automation');
    expect(resolveActiveFinanceTab('automation', false)).toBe('financial');
  });

  it('leaves other tabs unchanged regardless of flag', () => {
    expect(resolveActiveFinanceTab('financial', false)).toBe('financial');
    expect(resolveActiveFinanceTab('accounting', false)).toBe('accounting');
    expect(resolveActiveFinanceTab('accounting', true)).toBe('accounting');
  });
});
