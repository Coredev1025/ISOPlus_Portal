import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createApp } from '../../../src/app.js';
import { server } from '../../msw/server.js';
import { authenticatedAgent } from '../../helpers/auth.js';
import Item from '../../../src/models/Item.js';
import Business from '../../../src/models/Business.js';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';

/**
 * src/routes/exportOptimized.js. The three routes are thin: they authenticate,
 * then hand off to the CSV helpers (invoice, NDIS claim) or to
 * services/monthlyStatementData.js. These tests pin the auth gate, the
 * pre-flight validation each helper performs, and the filtering that decides
 * which rows come back — all against real documents in Mongo.
 */

const app = createApp();
const API_BASE = 'https://app.isoplus.online/api/v2';

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

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

describe('export routes require authentication', () => {
  it.each([
    '/api/export/w1/b1/invoice-csv',
    '/api/export/w1/b1/invoice-csv-ndis',
    '/api/export/w1/b1/monthly-statement-csv',
  ])('rejects an unauthenticated GET %s with 401', async (path) => {
    const res = await request(app).get(path);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Authentication required' });
  });
});

describe('GET /api/export/:workspaceId/:boardId/invoice-csv', () => {
  it('returns an empty export with zeroed totals when the board has no items', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);

    const res = await agent.get(`/api/export/${workspaceId}/${boardId}/invoice-csv`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.totalAmount).toBe(0);
    expect(res.body.totalGovSubsidy).toBe(0);
    expect(res.body.totalParticipantContribution).toBe(0);
  });

  it('sums the money columns across the exported rows', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Total Amount ($)': '100.50',
        'Government Subsidy ($)': '70.50',
        'Participant Contribution ($)': '30',
      },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Total Amount ($)': 49.5,
        'Government Subsidy ($)': 29.5,
        'Participant Contribution ($)': 20,
      },
    });

    const res = await agent.get(`/api/export/${workspaceId}/${boardId}/invoice-csv`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.totalAmount).toBe(150);
    expect(res.body.totalGovSubsidy).toBe(100);
    expect(res.body.totalParticipantContribution).toBe(50);
  });

  it('filters out rows whose scheduled start falls outside the requested window', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Scheduled Shift Start Date & Time': '2026-03-10T09:00:00.000Z',
        'Total Amount ($)': 10,
      },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Scheduled Shift Start Date & Time': '2026-05-10T09:00:00.000Z',
        'Total Amount ($)': 20,
      },
    });

    const res = await agent
      .get(`/api/export/${workspaceId}/${boardId}/invoice-csv`)
      .query({ startDate: '2026-03-01', endDate: '2026-03-31' });

    expect(res.body.total).toBe(1);
    expect(res.body.totalAmount).toBe(10);
  });

  it('filters on the transaction status but treats "all" as no filter', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Transaction Status': 'Delivered - To be claimed and invoiced.', 'Total Amount ($)': 10 },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Transaction Status': 'Cancelled', 'Total Amount ($)': 20 },
    });

    const filtered = await agent
      .get(`/api/export/${workspaceId}/${boardId}/invoice-csv`)
      .query({ transactionStatus: 'Cancelled' });
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.totalAmount).toBe(20);

    stubFolders(workspaceId, boardId, []);
    const unfiltered = await agent
      .get(`/api/export/${workspaceId}/${boardId}/invoice-csv`)
      .query({ transactionStatus: 'all' });
    expect(unfiltered.body.total).toBe(2);
  });

  it('scopes the export to the Master Plan folders when ISO+ lists them', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, [
      { id: 'master-plan', name: 'Master Plan' },
      { id: 'intake', name: '📋 Participants Intake' },
    ]);
    await seedItem({ workspaceId, boardId, folderId: 'master-plan', data: { 'Total Amount ($)': 5 } });
    await seedItem({ workspaceId, boardId, folderId: 'intake', data: { 'Total Amount ($)': 5000 } });

    const res = await agent.get(`/api/export/${workspaceId}/${boardId}/invoice-csv`);

    expect(res.body.total).toBe(1);
    expect(res.body.totalAmount).toBe(5);
  });

  it('attaches the stored invoice number to the exported row', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    const itemId = await seedItem({ workspaceId, boardId, data: { 'Total Amount ($)': 10 } });
    await InvoiceNumber.create({
      itemId,
      workspaceId,
      boardId,
      invoiceNumber: 'INV-1234',
      type: 'PDF',
    });

    const res = await agent.get(`/api/export/${workspaceId}/${boardId}/invoice-csv`);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].invoiceNumber).toBe('INV-1234');
  });
});

describe('GET /api/export/:workspaceId/:boardId/invoice-csv-ndis', () => {
  it('refuses to export when the business has no company registration id', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');

    const res = await agent.get(`/api/export/${workspaceId}/b1/invoice-csv-ndis`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'NDIS claim CSV export requires a Company Registration ID. Open ISO+ Portal → Business Configuration, enter your Company Registration ID, save your changes, and try the export again.'
    );
  });

  it('refuses to export when the business has a registration id but no ABN', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    await Business.create({ workspaceId, name: 'Acme Care', companyRegistrationId: '405000123' });

    const res = await agent.get(`/api/export/${workspaceId}/b1/invoice-csv-ndis`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'NDIS claim CSV export requires an ABN. Open ISO+ Portal → Business Configuration, enter your ABN, save your changes, and try the export again.'
    );
  });

  it('considers only approved rows, and skips the approved ones with no NDIS number', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Business.create({
      workspaceId,
      name: 'Acme Care',
      companyRegistrationId: '405000123',
      abn: '12345678901',
    });
    stubFolders(workspaceId, boardId, []);
    const approvedId = await seedItem({
      workspaceId,
      boardId,
      data: { 'Timesheet Approval': 'Approved', 'Participant Full Name': 'Approved Person' },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Timesheet Approval': 'Pending', 'Participant Full Name': 'Pending Person' },
    });

    const res = await agent.get(`/api/export/${workspaceId}/${boardId}/invoice-csv-ndis`);

    expect(res.status).toBe(200);
    // Only the approved row reaches the NDIS-number check; the pending one is
    // filtered out earlier and so is never reported as skipped.
    expect(res.body.skippedCount).toBe(1);
    expect(res.body.skipped.map((s) => s.itemId)).toEqual([approvedId]);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /api/export/:workspaceId/:boardId/monthly-statement-csv', () => {
  it('defaults to the service export and reports the row count and duration', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Participant Full Name': 'Jane Smith',
        'Total Amount ($)': '120.00',
        'Transaction Status': 'Delivered - To be claimed and invoiced.',
      },
    });

    const res = await agent.get(`/api/export/${workspaceId}/${boardId}/monthly-statement-csv`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(typeof res.body.exportDurationMs).toBe('number');
  });

  it('filters service rows by participant name', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Jane Smith' } });
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Bob Jones' } });

    const res = await agent
      .get(`/api/export/${workspaceId}/${boardId}/monthly-statement-csv`)
      .query({ participant: 'Jane Smith' });

    expect(res.body.total).toBe(1);
    expect(res.body.items[0].participant).toBe('Jane Smith');
  });

  it('switches to the budget export when type=budget', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    // Budget rows are scoped to the budget category folders; without a matching
    // folder the query is unscoped and every item on the board is a budget row.
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Participant Full Name': 'Jane Smith', Month: 'March', Year: '2026' },
    });

    const res = await agent
      .get(`/api/export/${workspaceId}/${boardId}/monthly-statement-csv`)
      .query({ type: 'budget' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].month).toBe('March');
    expect(res.body.items[0].year).toBe('2026');
  });

  it('filters budget rows by month and year', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { Month: 'March', Year: '2026' } });
    await seedItem({ workspaceId, boardId, data: { Month: 'April', Year: '2026' } });
    await seedItem({ workspaceId, boardId, data: { Month: 'March', Year: '2025' } });

    const res = await agent
      .get(`/api/export/${workspaceId}/${boardId}/monthly-statement-csv`)
      .query({ type: 'budget', month: '3', year: '2026' });

    expect(res.body.total).toBe(1);
  });

  it('ignores a month parameter that is not a calendar month number', async () => {
    const { agent } = await authenticatedAgent(app);
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { Month: 'March', Year: '2026' } });

    const res = await agent
      .get(`/api/export/${workspaceId}/${boardId}/monthly-statement-csv`)
      .query({ type: 'budget', month: '13' });

    expect(res.body.total).toBe(1);
  });
});
