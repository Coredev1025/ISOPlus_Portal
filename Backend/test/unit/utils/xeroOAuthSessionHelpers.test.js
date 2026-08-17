import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  readXeroOAuthSessionUser,
  xeroOAuthStateMatchesSession,
} from '../../../src/utils/xeroOAuthSessionHelpers.js';

describe('xeroOAuthSessionHelpers', () => {
  it('reads a verified session user and rejects a mismatched state userId', () => {
    const req = {
      session: {
        token: jwt.sign({ userId: 'user-1', role: 'owner' }, process.env.JWT_SECRET),
      },
    };
    expect(readXeroOAuthSessionUser(req)).toEqual({ userId: 'user-1', role: 'owner' });
    expect(readXeroOAuthSessionUser({})).toBeNull();
    expect(
      readXeroOAuthSessionUser({
        session: { token: jwt.sign({ userId: 'user-1' }, 'other-secret') },
      })
    ).toBeNull();
    expect(
      xeroOAuthStateMatchesSession({ userId: 'user-1' }, { userId: 'user-1' })
    ).toBe(true);
    expect(
      xeroOAuthStateMatchesSession({ userId: 'user-1' }, { userId: 'user-2' })
    ).toBe(false);
    expect(
      xeroOAuthStateMatchesSession({ userId: '' }, { userId: 'user-1' })
    ).toBe(false);
    expect(
      readXeroOAuthSessionUser({
        session: { token: jwt.sign({ role: 'owner' }, process.env.JWT_SECRET) },
      })
    ).toBeNull();
  });
});
