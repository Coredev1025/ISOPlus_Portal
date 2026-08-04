import { describe, it, expect } from 'vitest';
import User from '../../../src/models/User.js';

describe('User model', () => {
  it('hashes password on save and compares correctly', async () => {
    const user = await User.create({
      email: 'hash@isoplus.com',
      password: 'GoodPass!1',
      name: 'Hash User',
    });
    expect(user.password).not.toBe('GoodPass!1');
    expect(await user.comparePassword('GoodPass!1')).toBe(true);
    expect(await user.comparePassword('wrong')).toBe(false);
  });

  it('defaults role to isoplus_user', async () => {
    const user = await User.create({
      email: 'role@isoplus.com',
      password: 'GoodPass!1',
      name: 'Role',
    });
    expect(user.role).toBe('isoplus_user');
  });

  it('rejects invalid role enum', async () => {
    await expect(
      User.create({
        email: 'badrole@isoplus.com',
        password: 'GoodPass!1',
        name: 'Bad',
        role: 'superuser',
      })
    ).rejects.toThrow();
  });

  it('requires email and name', async () => {
    await expect(User.create({ password: 'GoodPass!1' })).rejects.toThrow();
  });
});
