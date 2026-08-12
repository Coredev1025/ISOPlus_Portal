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
    expect(resolveActiveFinanceTab('automation', true)).toBe('automation');
    expect(resolveActiveFinanceTab('automation', false)).toBe('financial');
  });

  it('leaves other tabs unchanged regardless of flag', () => {
    expect(resolveActiveFinanceTab('financial', false)).toBe('financial');
    expect(resolveActiveFinanceTab('financial', true)).toBe('financial');
    expect(resolveActiveFinanceTab('accounting', false)).toBe('accounting');
    expect(resolveActiveFinanceTab('accounting', true)).toBe('accounting');
  });
});
