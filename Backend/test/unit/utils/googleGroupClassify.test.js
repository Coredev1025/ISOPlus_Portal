import { describe, it, expect } from 'vitest';
import {
  classifyDirectoryMembershipError,
  isBreakGlassEmail,
  parseBreakGlassEmails,
} from '../../../src/utils/googleMembershipCacheHelpers.js';

describe('google group membership classification', () => {
  it('treats 404/400 hasMember responses as not_member', () => {
    expect(classifyDirectoryMembershipError({ code: 404 })).toBe('not_member');
    expect(classifyDirectoryMembershipError({ status: 400 })).toBe('not_member');
  });

  it('treats 401/403 and other failures as verify_error', () => {
    expect(classifyDirectoryMembershipError({ code: 401 })).toBe('verify_error');
    expect(classifyDirectoryMembershipError({ code: 403 })).toBe('verify_error');
    expect(classifyDirectoryMembershipError({ code: 500 })).toBe('verify_error');
  });

  it('parses break-glass emails from CSV', () => {
    expect(parseBreakGlassEmails('a@x.com, B@Y.COM ;c@z.com')).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
    ]);
  });

  it('matches break-glass emails case-insensitively', () => {
    expect(
      isBreakGlassEmail('Arnold@Example.com', ['arnold@example.com', 'other@x.com']),
    ).toBe(true);
    expect(isBreakGlassEmail('nobody@example.com', ['arnold@example.com'])).toBe(false);
  });
});
