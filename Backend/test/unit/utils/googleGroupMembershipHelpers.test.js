import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkUserGroupMembership } from '../../../src/utils/googleGroupMembershipHelpers.js';

const BASE_ENV = {
  GOOGLE_ADMIN_EMAIL: 'admin@example.com',
  GOOGLE_TARGET_GROUP: 'support-group@example.com',
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'sa@project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
  }),
};

describe('googleGroupMembershipHelpers', () => {
  const saved = {};

  beforeEach(() => {
    for (const key of Object.keys(BASE_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = BASE_ENV[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(BASE_ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('returns isMember true when Admin SDK reports membership', async () => {
    const hasMember = vi.fn(async () => ({ data: { isMember: true } }));
    const result = await checkUserGroupMembership('user@example.com', { hasMember });
    expect(result.isMember).toBe(true);
    expect(hasMember).toHaveBeenCalledWith({
      groupKey: 'support-group@example.com',
      memberKey: 'user@example.com',
    });
  });

  it('returns isMember false when Admin SDK reports non-membership', async () => {
    const hasMember = vi.fn(async () => ({ data: { isMember: false } }));
    const result = await checkUserGroupMembership('outsider@example.com', { hasMember });
    expect(result.isMember).toBe(false);
  });

  it('fails closed when Admin SDK throws', async () => {
    const hasMember = vi.fn(async () => {
      throw new Error('quota exceeded');
    });
    const result = await checkUserGroupMembership('user@example.com', { hasMember });
    expect(result.isMember).toBe(false);
    expect(result.error).toMatch(/quota exceeded/);
  });

  it('rejects blank email without calling Admin SDK', async () => {
    const hasMember = vi.fn();
    const result = await checkUserGroupMembership('   ', { hasMember });
    expect(result.isMember).toBe(false);
    expect(hasMember).not.toHaveBeenCalled();
  });
});
