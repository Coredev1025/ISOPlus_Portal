import { describe, it, expect } from 'vitest';
import OAuthTicket from '../../../src/models/OAuthTicket.js';

const oauthData = {
  id: 'isoplus-user-1',
  email: 'support@example.com',
  name: 'Support Admin',
  photo_url: 'https://cdn.example.com/a.png',
};

describe('OAuthTicket model', () => {
  it('allows a missing accessToken (Google support tickets have none)', async () => {
    const ticket = new OAuthTicket({ flow: 'google-support', oauthData });
    await expect(ticket.validate()).resolves.toBeUndefined();
    expect(ticket.accessToken).toBe('');
  });

  it('defaults flow to isoplus', async () => {
    const saved = await OAuthTicket.create({ accessToken: 'token-abc', oauthData });
    expect(saved.flow).toBe('isoplus');
  });

  it('accepts the google-support flow with an empty accessToken', async () => {
    const saved = await OAuthTicket.create({
      flow: 'google-support',
      accessToken: '',
      oauthData,
    });
    expect(saved.flow).toBe('google-support');
    expect(saved.accessToken).toBe('');
  });

  it('generates a 64-character hex ticket when none is supplied', async () => {
    const saved = await OAuthTicket.create({ accessToken: 'token-abc', oauthData });
    expect(saved.ticket).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates a different ticket for each document', async () => {
    const a = await OAuthTicket.create({ accessToken: 'token-a', oauthData });
    const b = await OAuthTicket.create({ accessToken: 'token-b', oauthData });
    expect(a.ticket).not.toBe(b.ticket);
  });

  it('keeps an explicitly supplied ticket', async () => {
    const saved = await OAuthTicket.create({
      ticket: 'explicit-ticket',
      accessToken: 'token-abc',
      oauthData,
    });
    expect(saved.ticket).toBe('explicit-ticket');
  });

  it('persists the nested oauthData fields', async () => {
    const saved = await OAuthTicket.create({ accessToken: 'token-abc', oauthData });
    const found = await OAuthTicket.findById(saved._id).lean();
    expect(found.oauthData).toMatchObject(oauthData);
  });

  it('defaults claimedAt to null so an unclaimed ticket is distinguishable', async () => {
    const saved = await OAuthTicket.create({ accessToken: 'token-abc', oauthData });
    expect(saved.claimedAt).toBeNull();
  });

  it('records a claim time once set', async () => {
    const saved = await OAuthTicket.create({ accessToken: 'token-abc', oauthData });
    const claimedAt = new Date('2026-08-10T04:05:06.000Z');
    await OAuthTicket.updateOne({ _id: saved._id }, { claimedAt });
    const found = await OAuthTicket.findById(saved._id).lean();
    expect(found.claimedAt.toISOString()).toBe('2026-08-10T04:05:06.000Z');
  });

  it('defaults createdAt to the current time', async () => {
    const before = Date.now();
    const saved = await OAuthTicket.create({ accessToken: 'token-abc', oauthData });
    expect(saved.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(saved.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('declares a 300-second TTL on createdAt so tickets are short-lived', () => {
    expect(OAuthTicket.schema.path('createdAt').options.expires).toBe(300);
  });

  it('rejects a second document reusing an existing ticket value', async () => {
    await OAuthTicket.init();
    await OAuthTicket.create({ ticket: 'dup', accessToken: 'token-a', oauthData });
    await expect(
      OAuthTicket.create({ ticket: 'dup', accessToken: 'token-b', oauthData }),
    ).rejects.toThrow();
  });

  it('finds an unclaimed ticket by its ticket value', async () => {
    await OAuthTicket.create({ ticket: 'lookup-me', accessToken: 'token-abc', oauthData });
    const found = await OAuthTicket.findOne({ ticket: 'lookup-me', claimedAt: null });
    expect(found.accessToken).toBe('token-abc');
  });
});
