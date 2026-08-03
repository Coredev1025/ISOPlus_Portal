import { describe, it, expect } from 'vitest';
import { secureRandomFloat, secureRandomInt, randomAlphanumeric } from '@/lib/secure-random';

describe('secure-random', () => {
  it('returns float in [0,1)', () => {
    const value = secureRandomFloat();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });

  it('returns int below max', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(secureRandomInt(5)).toBeLessThan(5);
      expect(secureRandomInt(5)).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns alphanumeric of requested length', () => {
    expect(randomAlphanumeric(12)).toMatch(/^[a-z0-9]{12}$/);
  });
});
