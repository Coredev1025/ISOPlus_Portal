import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import PDFLink from '../../src/models/PDFLink.js';

const app = createApp();

describe('PDF link routes', () => {
  it('returns 400 without workspaceId', async () => {
    const res = await request(app).get('/api/pdf-links');
    expect(res.status).toBe(400);
  });

  it('creates and lists pdf links', async () => {
    const create = await request(app).post('/api/pdf-links').send({
      itemId: 'item-1',
      workspaceId: 'ws-pdf',
      pdfLink: 'https://example.com/a.pdf',
      SignatureStatus: 'Unsigned',
      type: 'invoice',
      createdBy: 'tester',
    });
    expect(create.status).toBe(201);

    const list = await request(app).get('/api/pdf-links').query({ workspaceId: 'ws-pdf' });
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);

    const byItem = await request(app)
      .get('/api/pdf-links/item-1')
      .query({ workspaceId: 'ws-pdf' });
    expect(byItem.status).toBe(200);
    expect(byItem.body.length).toBe(1);

    const softDelete = await request(app).put('/api/pdf-links').send({
      workspaceId: 'ws-pdf',
      itemId: 'item-1',
      pdfLink: 'https://example.com/a.pdf',
    });
    expect(softDelete.status).toBe(200);
    const row = await PDFLink.findOne({ itemId: 'item-1', workspaceId: 'ws-pdf' });
    expect(row.isDeleted).toBe(true);
  });
});
