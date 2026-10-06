import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createApp } from '../../../src/app.js';
import { server } from '../../msw/server.js';
import { authenticatedAgent } from '../../helpers/auth.js';
import Item from '../../../src/models/Item.js';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';

/**
 * src/routes/items.js. Every route is behind authenticateToken with no further
 * role gate — and POST /api/auth/login signs every credentials session as
 * support_admin regardless of the stored role (src/routes/auth.js), so a
 * per-role gate could not be exercised through the login path anyway.
 *
 * The folder-scoping helper calls ISO+ for the board's folder list; each test
 * stubs that call explicitly so nothing reaches the network.
 */

const app = createApp();
const API_BASE = 'https://app.isoplus.online/api/v2';

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

/** Stub the ISO+ folder listing for one board. */
function stubFolders(workspaceId, boardId, folders = []) {
  server.use(
    http.get(`${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/folders/`, () =>
      HttpResponse.json({ data: folders, has_more: false, after: null })
    )
  );
}

async function seedItem({ workspaceId, boardId, folderId = 'f1', data = {}, itemId }) {
  const id = itemId || nextId('item');
  await Item.create({ workspaceId, boardId, folderId, itemId: id, data });
  return id;
}

describe('items routes require authentication', () => {
  it.each([
    '/api/items/w1/b1/i1',
    '/api/items/w1/b1/invoice-generator/participants',
    '/api/items/w1/b1/invoice-generator-ndis/participants',
    '/api/items/w1/b1/invoice-generator-ndis/payment-status-options',
    '/api/items/w1/b1/invoice-generator-ndis',
    '/api/items/w1/b1/monthly-statement/participants',
    '/api/items/w1/b1/invoice-generator',
    '/api/items/w1/b1/monthly-statement',
    '/api/items/cache/stats',
    '/api/items/w1/b1/invoice/INV-1/pdf-link',
  ])('rejects an unauthenticated GET %s with 401', async (path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Authentication required' });
  });

  it('rejects an unauthenticated POST to update-status with 401', async () => {
    const res = await request(app)
      .post('/api/items/w1/b1/update-status')
      .send({ itemIds: ['i1'], status: 'invoiced' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Authentication required' });
  });
});

describe('GET /api/items/:workspaceId/:boardId/:itemId', () => {
  it('answers 404 when nothing matches all three ids', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get(`/api/items/w1/b1/${nextId('missing')}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Item not found' });
  });

  it('answers 404 when the item exists on a different board', async () => {
    const { agent } = await authenticatedAgent(app);
    const itemId = await seedItem({ workspaceId: 'w1', boardId: 'b-other' });

    const res = await agent.get(`/api/items/w1/b1/${itemId}`);

    expect(res.status).toBe(404);
  });

  it('returns the stored item', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const itemId = await seedItem({
      workspaceId: 'w1',
      boardId,
      folderId: 'folder-7',
      data: { 'Participant Full Name': 'Jane Smith' },
    });

    const res = await agent.get(`/api/items/w1/${boardId}/${itemId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      itemId,
      workspaceId: 'w1',
      boardId,
      folderId: 'folder-7',
      data: { 'Participant Full Name': 'Jane Smith' },
    });
  });
});

describe('GET /api/items/cache/stats', () => {
  it('reports the transformation cache counters', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get('/api/items/cache/stats');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Transformation cache statistics');
    expect(Object.keys(res.body.cache).sort()).toEqual([
      'expiredEntries',
      'maxSize',
      'totalSize',
      'ttlMs',
      'validEntries',
    ]);
  });
});

describe('GET /api/items/:workspaceId/:boardId/invoice/:invoiceNumber/pdf-link', () => {
  it('answers 404 when there is no PDF invoice with that number', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.get('/api/items/w1/b1/invoice/INV-404/pdf-link');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Invoice not found or is not a PDF invoice' });
  });

  it('ignores a Xero invoice with the same number', async () => {
    const { agent } = await authenticatedAgent(app);
    await InvoiceNumber.create({
      itemId: 'i1',
      workspaceId: 'w1',
      boardId: 'b1',
      invoiceNumber: 'INV-500',
      type: 'Xero',
      pdfLink: 'https://example.com/xero.pdf',
    });

    const res = await agent.get('/api/items/w1/b1/invoice/INV-500/pdf-link');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Invoice not found or is not a PDF invoice' });
  });

  it('answers 404 with a different message when the record has no link', async () => {
    const { agent } = await authenticatedAgent(app);
    await InvoiceNumber.create({
      itemId: 'i1',
      workspaceId: 'w1',
      boardId: 'b1',
      invoiceNumber: 'INV-501',
      type: 'PDF',
    });

    const res = await agent.get('/api/items/w1/b1/invoice/INV-501/pdf-link');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'PDF link not available for this invoice' });
  });

  it('returns the link, the stored number and the item id', async () => {
    const { agent } = await authenticatedAgent(app);
    await InvoiceNumber.create({
      itemId: 'item-77',
      workspaceId: 'w1',
      boardId: 'b1',
      invoiceNumber: 'INV-502',
      type: 'PDF',
      pdfLink: 'https://example.com/invoice.pdf',
    });

    const res = await agent.get('/api/items/w1/b1/invoice/INV-502/pdf-link');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pdfLink: 'https://example.com/invoice.pdf',
      invoiceNumber: 'INV-502',
      itemId: 'item-77',
    });
  });

  it('falls back to the "(ISO+™)" suffixed number when the bare one misses', async () => {
    const { agent } = await authenticatedAgent(app);
    await InvoiceNumber.create({
      itemId: 'item-78',
      workspaceId: 'w1',
      boardId: 'b1',
      invoiceNumber: 'INV-503 (ISO+™)',
      type: 'PDF',
      pdfLink: 'https://example.com/suffixed.pdf',
    });

    const res = await agent.get('/api/items/w1/b1/invoice/INV-503/pdf-link');

    expect(res.status).toBe(200);
    expect(res.body.invoiceNumber).toBe('INV-503 (ISO+™)');
  });

  it('decodes a percent-encoded invoice number before looking it up', async () => {
    const { agent } = await authenticatedAgent(app);
    await InvoiceNumber.create({
      itemId: 'item-79',
      workspaceId: 'w1',
      boardId: 'b1',
      invoiceNumber: 'INV 504/A',
      type: 'PDF',
      pdfLink: 'https://example.com/encoded.pdf',
    });

    const res = await agent.get(
      `/api/items/w1/b1/invoice/${encodeURIComponent('INV 504/A')}/pdf-link`
    );

    expect(res.status).toBe(200);
    expect(res.body.pdfLink).toBe('https://example.com/encoded.pdf');
  });
});

describe('POST /api/items/:workspaceId/:boardId/update-status', () => {
  it('rejects a body without itemIds', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent.post('/api/items/w1/b1/update-status').send({ status: 'invoiced' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'itemIds must be a non-empty array' });
  });

  it('rejects an empty itemIds array', async () => {
    const { agent } = await authenticatedAgent(app);

    const res = await agent
      .post('/api/items/w1/b1/update-status')
      .send({ itemIds: [], status: 'invoiced' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'itemIds must be a non-empty array' });
  });

  it('reports ITEM_NOT_FOUND for an id that is not on the board', async () => {
    const { agent } = await authenticatedAgent(app);
    const missing = nextId('item');

    const res = await agent
      .post('/api/items/w1/b1/update-status')
      .send({ itemIds: [missing], status: 'invoiced' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updatedCount: 0,
      failedCount: 1,
      results: [{ itemId: missing, updated: false, reason: 'ITEM_NOT_FOUND' }],
    });
  });

  it('marks the item as invoiced and records the number and file url', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const itemId = await seedItem({ workspaceId: 'w1', boardId, data: { Title: 'Shift' } });

    const res = await agent.post(`/api/items/w1/${boardId}/update-status`).send({
      itemIds: [itemId],
      status: 'invoiced',
      invoiceNumber: 'INV-900',
      fileUrl: 'https://example.com/pdf',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updatedCount: 1,
      failedCount: 0,
      results: [{ itemId, updated: true }],
    });

    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data['Invoice Issued and Sent']).toBe(true);
    expect(stored.data['Generated Invoice Number']).toBe('INV-900');
    expect(stored.data['Invoice File URL']).toBe('https://example.com/pdf');
    expect(stored.data.Title).toBe('Shift');
  });

  it('maps a "pending" status to false rather than leaving it unset', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const itemId = await seedItem({
      workspaceId: 'w1',
      boardId,
      data: { 'Invoice Issued and Sent': true },
    });

    const res = await agent
      .post(`/api/items/w1/${boardId}/update-status`)
      .send({ itemIds: [itemId], status: 'pending' });

    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(1);
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data['Invoice Issued and Sent']).toBe(false);
  });

  it('reports NO_CHANGES_REQUIRED when an unrecognised status changes nothing', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const itemId = await seedItem({ workspaceId: 'w1', boardId, data: { Title: 'Shift' } });

    const res = await agent
      .post(`/api/items/w1/${boardId}/update-status`)
      .send({ itemIds: [itemId], status: 'something-else' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      updatedCount: 0,
      failedCount: 1,
      results: [{ itemId, updated: false, reason: 'NO_CHANGES_REQUIRED' }],
    });
    const stored = await Item.findOne({ itemId }).lean();
    expect(stored.data).toEqual({ Title: 'Shift' });
  });

  it('reports NO_CHANGES_REQUIRED when the values are already what was asked for', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const itemId = await seedItem({
      workspaceId: 'w1',
      boardId,
      data: { 'Invoice Issued and Sent': true, 'Generated Invoice Number': 'INV-901' },
    });

    const res = await agent
      .post(`/api/items/w1/${boardId}/update-status`)
      .send({ itemIds: [itemId], status: 'invoiced', invoiceNumber: 'INV-901' });

    expect(res.body.results[0].reason).toBe('NO_CHANGES_REQUIRED');
  });

  it('processes a mixed batch and counts each outcome', async () => {
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const good = await seedItem({ workspaceId: 'w1', boardId, data: {} });
    const missing = nextId('item');

    const res = await agent
      .post(`/api/items/w1/${boardId}/update-status`)
      .send({ itemIds: [good, missing], status: 'invoiced' });

    expect(res.body.updatedCount).toBe(1);
    expect(res.body.failedCount).toBe(1);
    expect(res.body.results.map((r) => r.itemId)).toEqual([good, missing]);
  });

  it('coerces a single itemId string into a one-element batch', async () => {
    // toQueryStringArray wraps a non-array value rather than rejecting it.
    const { agent } = await authenticatedAgent(app);
    const boardId = nextId('board');
    const itemId = await seedItem({ workspaceId: 'w1', boardId, data: {} });

    const res = await agent
      .post(`/api/items/w1/${boardId}/update-status`)
      .send({ itemIds: itemId, status: 'invoiced' });

    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(1);
  });
});

describe('GET /api/items/:workspaceId/:boardId/invoice-generator/participants', () => {
  it('returns distinct participant names sorted alphabetically', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    const name = 'Full Name/Preferred Name';
    await seedItem({ workspaceId, boardId, data: { [name]: 'Zoe Wu' } });
    await seedItem({ workspaceId, boardId, data: { [name]: 'Alan Brown' } });
    await seedItem({ workspaceId, boardId, data: { [name]: 'Alan Brown' } });

    const res = await agent.get(
      `/api/items/${workspaceId}/${boardId}/invoice-generator/participants`
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ participants: ['Alan Brown', 'Zoe Wu'] });
  });

  it('drops items that carry no participant name', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { 'Full Name/Preferred Name': 'Ada L' } });
    await seedItem({ workspaceId, boardId, data: { Title: 'no name here' } });

    const res = await agent.get(
      `/api/items/${workspaceId}/${boardId}/invoice-generator/participants`
    );

    expect(res.body.participants).toEqual(['Ada L']);
  });

  it('restricts the search to the Participants Intake folder when ISO+ reports one', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, [
      { id: 'intake-folder', name: '📋 Participants Intake' },
      { id: 'other-folder', name: 'Shift Planning and Reporting' },
    ]);
    await seedItem({
      workspaceId,
      boardId,
      folderId: 'intake-folder',
      data: { 'Full Name/Preferred Name': 'Inside Folder' },
    });
    await seedItem({
      workspaceId,
      boardId,
      folderId: 'other-folder',
      data: { 'Full Name/Preferred Name': 'Outside Folder' },
    });

    const res = await agent.get(
      `/api/items/${workspaceId}/${boardId}/invoice-generator/participants`
    );

    expect(res.body.participants).toEqual(['Inside Folder']);
  });

  it('does not leak participants from another board', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { 'Full Name/Preferred Name': 'Mine' } });
    await seedItem({
      workspaceId,
      boardId: nextId('otherboard'),
      data: { 'Full Name/Preferred Name': 'Theirs' },
    });

    const res = await agent.get(
      `/api/items/${workspaceId}/${boardId}/invoice-generator/participants`
    );

    expect(res.body.participants).toEqual(['Mine']);
  });
});

describe('GET /api/items/:workspaceId/:boardId/monthly-statement/participants', () => {
  it('uses the same intake-folder participant list as the invoice generator', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { 'Full Name/Preferred Name': 'Bea Kay' } });

    const res = await agent.get(
      `/api/items/${workspaceId}/${boardId}/monthly-statement/participants`
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ participants: ['Bea Kay'] });
  });
});

describe('GET /api/items/:workspaceId/:boardId/invoice-generator-ndis/participants', () => {
  it('only counts rows whose timesheet approval is Approved', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Timesheet Approval': 'Approved', 'Participant Full Name': 'Approved Person' },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Timesheet Approval': 'Pending', 'Participant Full Name': 'Pending Person' },
    });

    const res = await agent.get(
      `/api/items/${workspaceId}/${boardId}/invoice-generator-ndis/participants`
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ participants: ['Approved Person'] });
  });

  it('prefers the name on the referenced participant profile over the row', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    const profileId = '11111111-2222-4333-8444-555555555555';
    await seedItem({
      workspaceId,
      boardId,
      itemId: profileId,
      data: { 'Full Name/Preferred Name': 'Profile Name' },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Timesheet Approval': [{ name: 'Approved' }],
        'Participant Profile': [profileId],
        'Participant Full Name': 'Row Name',
      },
    });

    const res = await agent.get(
      `/api/items/${workspaceId}/${boardId}/invoice-generator-ndis/participants`
    );

    expect(res.body.participants).toEqual(['Profile Name']);
  });
});

describe('GET /api/items/:workspaceId/:boardId/invoice-generator-ndis/payment-status-options', () => {
  it('lists the distinct payment statuses of approved rows, sorted', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Timesheet Approval': 'Approved', 'Payment Status': 'Paid' },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Timesheet Approval': 'Approved', 'Payment Status': 'Awaiting Payment' },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Timesheet Approval': 'Approved', 'Payment Status': 'Paid' },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Timesheet Approval': 'Rejected', 'Payment Status': 'Written Off' },
    });

    const res = await agent.get(
      `/api/items/${workspaceId}/${boardId}/invoice-generator-ndis/payment-status-options`
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ options: ['Awaiting Payment', 'Paid'] });
  });

  it('returns an empty option list when nothing is approved', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Timesheet Approval': 'Pending', 'Payment Status': 'Paid' },
    });

    const res = await agent.get(
      `/api/items/${workspaceId}/${boardId}/invoice-generator-ndis/payment-status-options`
    );

    expect(res.body).toEqual({ options: [] });
  });
});
