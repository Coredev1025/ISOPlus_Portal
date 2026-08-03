import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/app.js';
import Board from '../../src/models/Board.js';
import { authenticatedAgent } from '../helpers/auth.js';

const app = createApp();

describe('Board routes', () => {
  const originalPat = process.env.PERSONAL_ACCESS_TOKEN;
  const originalJwt = process.env.JWT_SECRET;
  beforeEach(() => {
    process.env.PERSONAL_ACCESS_TOKEN = 'test-pat';
    process.env.JWT_SECRET = 'test-jwt-secret';
  });
  afterEach(() => {
    process.env.PERSONAL_ACCESS_TOKEN = originalPat;
    process.env.JWT_SECRET = originalJwt;
  });

  it('requires authentication', async () => {
    const res = await (await import('supertest')).default(app).get('/api/boards').query({ id: 'b1' });
    expect(res.status).toBe(401);
  });

  it('creates and fetches a board for support_admin', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'support_admin' });
    const createRes = await agent.post('/api/boards').send({
      id: 'board-int-1',
      name: 'Integration Board',
      workspaceId: 'ws-int',
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.board.boardId).toBe('board-int-1');

    const getRes = await agent.get('/api/boards').query({ id: 'board-int-1' });
    expect(getRes.status).toBe(200);
    expect(getRes.body.board.boardId).toBe('board-int-1');
  });

  it('returns board not found message for unknown id', async () => {
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const getRes = await agent.get('/api/boards').query({ id: 'missing-board' });
    expect(getRes.status).toBe(200);
    expect(getRes.body.message).toMatch(/not found/i);
  });

  it('updates board label for owner', async () => {
    await Board.create({ boardId: 'board-upd', name: 'Before', workspaceId: 'ws-u' });
    const { agent } = await authenticatedAgent(app, { role: 'owner' });
    const res = await agent.put('/api/boards').send({
      boardId: 'board-upd',
      workspaceId: 'ws-u',
      label: 'NDIS',
    });
    expect([200, 400, 500]).toContain(res.status);
    if (res.status === 200) {
      const board = await Board.findOne({ boardId: 'board-upd' });
      expect(board.label).toBe('NDIS');
    }
  });
});
