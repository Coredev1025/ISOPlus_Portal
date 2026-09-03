import { describe, it, expect } from 'vitest';
import {
  createPkcePair,
  verifyPkceSessionBinding,
} from '../../../src/utils/googlePkceHelpers.js';

describe('googlePkceHelpers', () => {
  it('creates a verifier and S256 challenge', () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.method).toBe('S256');
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it('accepts matching session state and verifier', () => {
    const result = verifyPkceSessionBinding({
      returnedState: 'state-abc',
      sessionState: 'state-abc',
      sessionVerifier: 'verifier-xyz',
    });
    expect(result).toEqual({ ok: true, verifier: 'verifier-xyz' });
  });

  it('rejects missing pre-auth session binding', () => {
    expect(
      verifyPkceSessionBinding({
        returnedState: 'state-abc',
        sessionState: null,
        sessionVerifier: null,
      }).ok,
    ).toBe(false);
  });

  it('rejects state mismatch (login CSRF)', () => {
    const result = verifyPkceSessionBinding({
      returnedState: 'attacker-state',
      sessionState: 'victim-state',
      sessionVerifier: 'verifier-xyz',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('state_mismatch');
  });
});
