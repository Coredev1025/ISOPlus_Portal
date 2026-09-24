import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { authenticatedAgent } from '../helpers/auth.js';
import mongoose from 'mongoose';

const app = createApp();

describe('Log routes', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/log');
    expect(res.status).toBe(401);
  });

  it('allows support_admin to list logs', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
    const res = await agent.get('/api/log');
    expect(res.status).toBe(200);
  });

  /**
   * KAN-267. The automation logs "No billable items for the period; no invoice
   * and no email" with the workspace, board and period in its metadata — and
   * the viewer could not reach it. Search matched only `message` and
   * `metadata.source`, and there was no workspace filter, so the one line that
   * explains a silent run sat unreachable among tens of thousands.
   */
  describe('finding the run that explains itself', () => {
    const ZERO_OUTPUT = 'No billable items for the period; no invoice and no email';

    const seed = async () => {
      const logs = mongoose.connection.collection('logs');
      await logs.deleteMany({});
      await logs.insertMany([
        {
          message: ZERO_OUTPUT,
          level: 'info',
          timestamp: new Date('2026-09-24T02:00:00.000Z'),
          metadata: {
            source: 'Automation', workspaceId: '55515', boardId: 'oiGa5qGq1N6',
            periodKey: '20260924-1200', listed: 0,
          },
        },
        {
          message: ZERO_OUTPUT,
          level: 'info',
          timestamp: new Date('2026-09-24T02:00:01.000Z'),
          metadata: {
            source: 'Automation', workspaceId: '99999', boardId: 'other-board',
            periodKey: '20260924-1200', listed: 0,
          },
        },
        {
          message: 'Something unrelated on the same workspace',
          level: 'info',
          timestamp: new Date('2026-09-24T02:00:02.000Z'),
          metadata: { source: 'Sync', workspaceId: '55515' },
        },
      ]);
    };

    it('filters to one workspace', async () => {
      await seed();
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

      const res = await agent.get('/api/log').query({ workspaceId: '55515' });

      expect(res.status).toBe(200);
      const ids = res.body.items.map((l) => l.metadata?.workspaceId ?? l.workspaceId);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids)).toEqual(new Set(['55515']));
    });

    it('filters to one board, so a fan-out across boards can be told apart', async () => {
      await seed();
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

      const res = await agent.get('/api/log').query({ boardId: 'oiGa5qGq1N6' });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].message).toBe(ZERO_OUTPUT);
    });

    // Typing the workspace id into the search box is what an operator does
    // first. It matched nothing, because search never looked at the metadata
    // that identifies a run.
    it('searches the identifying metadata, not just the message and source', async () => {
      await seed();
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

      const byWorkspace = await agent.get('/api/log').query({ search: '55515' });
      expect(byWorkspace.body.items.length).toBeGreaterThan(0);

      const byPeriod = await agent.get('/api/log').query({ search: '20260924-1200' });
      expect(byPeriod.body.items.length).toBe(2);
    });

    it('combines a workspace filter with a source filter', async () => {
      await seed();
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

      const res = await agent.get('/api/log')
        .query({ workspaceId: '55515', source: 'Automation' });

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].message).toBe(ZERO_OUTPUT);
    });

    // A filter nobody set must not quietly narrow the list.
    it('returns everything when no scope is given', async () => {
      await seed();
      const { agent } = await authenticatedAgent(app, { role: 'support_admin' });

      const res = await agent.get('/api/log');
      expect(res.body.items).toHaveLength(3);
    });
  });
});
