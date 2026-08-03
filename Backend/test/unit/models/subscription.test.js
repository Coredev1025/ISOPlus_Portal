import { describe, it, expect } from 'vitest';
import Subscription from '../../../src/models/Subscription.js';

describe('Subscription model', () => {
  it('requires givenName, familyName, email and xeroUserId', async () => {
    await expect(Subscription.create({})).rejects.toThrow();
  });

  it('creates with default status', async () => {
    const sub = await Subscription.create({
      givenName: 'A',
      familyName: 'B',
      email: 'a@b.com',
      xeroUserId: 'xero-1',
    });
    expect(sub.status).toBe('request_received');
  });

  it('rejects invalid status', async () => {
    await expect(
      Subscription.create({
        givenName: 'A',
        familyName: 'B',
        email: 'c@d.com',
        xeroUserId: 'xero-2',
        status: 'unknown',
      })
    ).rejects.toThrow();
  });
});
