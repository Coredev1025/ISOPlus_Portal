import { describe, it, expect } from 'vitest';
import {
  toMongoQueryValue,
  getSafeString,
  toQueryString,
  toRequiredQueryString,
  toQueryStringArray,
  pickAllowedSortField,
  pickAllowedValue,
  mongoEq,
  sanitizeApiPathSegment,
  assertIsoPlusUrl,
  buildIsoPlusV2WorkspaceBoardsUrl,
  buildIsoPlusV2BoardItemsRelativePath,
  buildIsoPlusAutomationUrl,
  randomBytesHex,
  randomAlphanumeric,
  secureRandomFloat,
} from '../../../src/utils/securityHelpers.js';

describe('toMongoQueryValue', () => {
  it('accepts plain scalars as strings', () => {
    expect(toMongoQueryValue('abc')).toBe('abc');
    expect(toMongoQueryValue(12)).toBe('12');
    expect(toMongoQueryValue(true)).toBe('true');
  });

  it('rejects objects and arrays', () => {
    expect(toMongoQueryValue({ $ne: '' })).toBeNull();
    expect(toMongoQueryValue(['a'])).toBeNull();
    expect(toMongoQueryValue(null)).toBeNull();
  });
});

describe('getSafeString / toQueryString helpers', () => {
  it('trims and rejects empty strings', () => {
    expect(getSafeString('  hi  ')).toBe('hi');
    expect(getSafeString('   ')).toBeNull();
    expect(getSafeString(1)).toBeNull();
  });

  it('toQueryString and toRequiredQueryString behave as expected', () => {
    expect(toQueryString('x')).toBe('x');
    expect(toRequiredQueryString({ $gt: 1 })).toBe('');
    expect(toQueryStringArray(['a', { $ne: 1 }, 'b'])).toEqual(['a', 'b']);
    expect(toQueryStringArray('solo')).toEqual(['solo']);
  });
});

describe('pickAllowed helpers', () => {
  it('picks allowed sort field or default', () => {
    expect(pickAllowedSortField('createdAt', ['createdAt', 'action'], 'createdAt')).toBe('createdAt');
    expect(pickAllowedSortField('hack', ['createdAt'], 'createdAt')).toBe('createdAt');
  });

  it('picks allowed value or default', () => {
    expect(pickAllowedValue('asc', ['asc', 'desc'], 'desc')).toBe('asc');
    expect(pickAllowedValue('nope', ['asc'], 'desc')).toBe('desc');
  });
});

describe('mongoEq / sanitizeApiPathSegment', () => {
  it('mongoEq returns scalar or throws', () => {
    expect(mongoEq('id-1')).toBe('id-1');
    expect(() => mongoEq({ $ne: '' })).toThrow();
  });

  it('rejects path traversal segments', () => {
    expect(sanitizeApiPathSegment('abc')).toBe('abc');
    expect(() => sanitizeApiPathSegment('../x')).toThrow();
    expect(() => sanitizeApiPathSegment('a/b')).toThrow();
    expect(() => sanitizeApiPathSegment('')).toThrow();
    expect(() => sanitizeApiPathSegment(null)).toThrow();
  });
});

describe('IsoPlus URL builders', () => {
  it('assertIsoPlusUrl allows only app.isoplus.online https', () => {
    expect(assertIsoPlusUrl('https://app.isoplus.online/api/v2/x')).toContain('app.isoplus.online');
    expect(() => assertIsoPlusUrl('https://evil.example/x')).toThrow();
  });

  it('builds workspace boards url', () => {
    expect(buildIsoPlusV2WorkspaceBoardsUrl('ws1')).toBe(
      'https://app.isoplus.online/api/v2/workspaces/ws1/boards'
    );
  });

  it('builds relative items path and automation url', () => {
    expect(buildIsoPlusV2BoardItemsRelativePath('ws', 'b1')).toBe(
      'workspaces/ws/boards/b1/items'
    );
    expect(buildIsoPlusAutomationUrl('ws', 'auto1')).toBe(
      'https://app.isoplus.online/api/ws/automations/auto1'
    );
  });
});

describe('random helpers', () => {
  it('produces hex / alphanumeric / float in range', () => {
    expect(randomBytesHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomAlphanumeric(10)).toMatch(/^[a-z0-9]{10}$/);
    const f = secureRandomFloat();
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });
});
