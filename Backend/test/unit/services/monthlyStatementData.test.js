import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server.js';
import Item from '../../../src/models/Item.js';
import Business from '../../../src/models/Business.js';
import {
  fetchBudgetItems,
  fetchServiceItems,
} from '../../../src/services/monthlyStatementData.js';

/**
 * src/services/monthlyStatementData.js reads the synced Items out of Mongo and
 * shapes them for the monthly statement. The only outbound call is the ISO+
 * folder listing, which decides both the query scope and — for budget rows —
 * which budget category each row belongs to; that call is stubbed per test.
 */

const API = 'https://app.isoplus.online/api/v2';

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

function stubFolders(workspaceId, boardId, folders = []) {
  server.use(
    http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/folders/`, () =>
      HttpResponse.json({ data: folders, has_more: false, after: null })
    )
  );
}

function stubFoldersUnavailable(workspaceId, boardId) {
  server.use(
    http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/folders/`, () =>
      HttpResponse.json({ message: 'boom' }, { status: 500 })
    )
  );
}

async function seedItem({ workspaceId, boardId, folderId = 'f1', data = {}, itemId, updatedAt }) {
  const id = itemId || nextId('item');
  const created = await Item.create({
    workspaceId,
    boardId,
    folderId,
    itemId: id,
    data,
  });
  if (updatedAt) {
    // Mongoose's timestamps option overwrites updatedAt on create, so an
    // explicit value only sticks with a second write that disables it.
    await Item.updateOne({ _id: created._id }, { $set: { updatedAt } }, { timestamps: false });
  }
  return id;
}

describe('fetchBudgetItems', () => {
  it('maps each item to the budget category of the folder it sits in', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, [
      { id: 'folder-hsq', name: 'Home Support Quarterly Budget' },
      { id: 'folder-hmb', name: 'Home Modification Budget' },
    ]);
    await seedItem({ workspaceId, boardId, folderId: 'folder-hmb', data: { Month: 'March' } });
    await seedItem({ workspaceId, boardId, folderId: 'folder-hsq', data: { Month: 'March' } });

    const result = await fetchBudgetItems(workspaceId, boardId);

    // HSQ comes before HMB in BUDGET_CATEGORY_ORDER, so the sort reorders them.
    expect(result.map((r) => r.categoryCode)).toEqual(['HSQ', 'HMB']);
    expect(result.map((r) => r.folderName)).toEqual([
      'Home Support Quarterly Budget',
      'Home Modification Budget',
    ]);
  });

  it('defaults to HSQ when the folder is not one of the budget folders', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, folderId: 'unmapped', data: { Month: 'March' } });

    const result = await fetchBudgetItems(workspaceId, boardId);

    expect(result).toHaveLength(1);
    expect(result[0].categoryCode).toBe('HSQ');
    expect(result[0].folderName).toBe('');
  });

  it('still returns rows when the ISO+ folder call fails', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFoldersUnavailable(workspaceId, boardId);
    await seedItem({ workspaceId, boardId, data: { Month: 'March' } });

    const result = await fetchBudgetItems(workspaceId, boardId);

    expect(result).toHaveLength(1);
    expect(result[0].categoryCode).toBe('HSQ');
  });

  it('takes the participant name from the referenced profile in preference to the row', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    const profileId = nextId('profile');
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
        'Participant Profile': [profileId],
        'Participant Full Name': 'Row Name',
        Month: 'March',
      },
    });

    const result = await fetchBudgetItems(workspaceId, boardId);
    const budgetRow = result.find((r) => r.id !== profileId);

    expect(budgetRow.participantName).toBe('Profile Name');
    expect(budgetRow.participantProfileId).toBe(profileId);
  });

  it('filters by participant name, case- and whitespace-insensitively', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Jane Smith' } });
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Bob Jones' } });

    const result = await fetchBudgetItems(workspaceId, boardId, { participant: '  jane smith ' });

    expect(result.map((r) => r.participantName)).toEqual(['Jane Smith']);
  });

  it('filters by month using the calendar name the row stores', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { Month: 'March', Year: '2026' } });
    await seedItem({ workspaceId, boardId, data: { Month: 'April', Year: '2026' } });

    const result = await fetchBudgetItems(workspaceId, boardId, { month: '03' });

    expect(result.map((r) => r.month)).toEqual(['March']);
  });

  it('ignores a month outside 1-12 rather than returning nothing', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { Month: 'March' } });

    const result = await fetchBudgetItems(workspaceId, boardId, { month: '0' });

    expect(result).toHaveLength(1);
  });

  it('filters by year', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { Month: 'March', Year: '2026' } });
    await seedItem({ workspaceId, boardId, data: { Month: 'March', Year: '2025' } });

    const result = await fetchBudgetItems(workspaceId, boardId, { year: '2025' });

    expect(result.map((r) => r.year)).toEqual(['2025']);
  });

  it('filters by category code', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, [
      { id: 'folder-hsq', name: 'Home Support Quarterly Budget' },
      { id: 'folder-ats', name: 'Assistive Technology - Short-term Budget' },
    ]);
    await seedItem({ workspaceId, boardId, folderId: 'folder-hsq', data: {} });
    await seedItem({ workspaceId, boardId, folderId: 'folder-ats', data: {} });

    const result = await fetchBudgetItems(workspaceId, boardId, { categoryCode: 'ATS' });

    expect(result.map((r) => r.categoryCode)).toEqual(['ATS']);
  });

  it('reads the money columns off the row', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, [{ id: 'folder-hsq', name: 'Home Support Quarterly Budget' }]);
    await seedItem({
      workspaceId,
      boardId,
      folderId: 'folder-hsq',
      data: {
        'Available Fund at the Start of the Month ($)': '$1,000.00',
        'Carryover Funding from the Previous Quarter ($)': '250',
        'Home Support Delivered During the Month ($-)': '400',
      },
    });

    const [row] = await fetchBudgetItems(workspaceId, boardId);

    expect(row.availableFundStart).toBe(1000);
    expect(row.carryoverFunding).toBe(250);
    // ($-) columns are outflows and are normalised to a negative amount.
    expect(row.deliveredAmount).toBe(-400);
  });

  it('scopes the query to the budget folders when ISO+ reports them', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, [{ id: 'folder-hsq', name: 'Home Support Quarterly Budget' }]);
    await seedItem({ workspaceId, boardId, folderId: 'folder-hsq', data: {} });
    await seedItem({ workspaceId, boardId, folderId: 'somewhere-else', data: {} });

    const result = await fetchBudgetItems(workspaceId, boardId);

    expect(result).toHaveLength(1);
  });
});

describe('fetchServiceItems', () => {
  it('returns one shaped row per synced item', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    const itemId = await seedItem({
      workspaceId,
      boardId,
      data: {
        'Participant Full Name': 'Jane Smith',
        Unit: 'Hour',
        Quantity: '2',
        'Unit Price ($)': '$50.00',
        'Total Amount ($)': '$100.00',
        'Government Subsidy ($)': '90',
        'Participant Contribution ($)': '10',
        'Additional Notes': 'Morning shift',
      },
    });

    const [row] = await fetchServiceItems(workspaceId, boardId);

    expect(row.id).toBe(itemId);
    expect(row.participant).toBe('Jane Smith');
    expect(row.unit).toBe('Hour');
    expect(row.quantity).toBe(2);
    expect(row.unitPrice).toBe(50);
    expect(row.totalAmount).toBe(100);
    expect(row.govSubsidy).toBe(90);
    expect(row.participantContribution).toBe(10);
    expect(row.notes).toBe('Morning shift');
  });

  it('defaults the unit to Hour when the row has none', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Jane Smith' } });

    const [row] = await fetchServiceItems(workspaceId, boardId);

    expect(row.unit).toBe('Hour');
    expect(row.quantity).toBe(0);
  });

  it('scopes to the Master Plan and Shift Planning folders when ISO+ reports them', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, [
      { id: 'folder-mp', name: 'Master Plan' },
      { id: 'folder-intake', name: '📋 Participants Intake' },
    ]);
    await seedItem({
      workspaceId,
      boardId,
      folderId: 'folder-mp',
      data: { 'Participant Full Name': 'Inside' },
    });
    await seedItem({
      workspaceId,
      boardId,
      folderId: 'folder-intake',
      data: { 'Participant Full Name': 'Outside' },
    });

    const result = await fetchServiceItems(workspaceId, boardId);

    expect(result.map((r) => r.participant)).toEqual(['Inside']);
  });

  it('matches the participant filter as a case-insensitive substring', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Jane Smith' } });
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Bob Jones' } });

    const result = await fetchServiceItems(workspaceId, boardId, { participant: 'jane' });

    expect(result.map((r) => r.participant)).toEqual(['Jane Smith']);
  });

  it('treats a participant filter of "all" as no filter', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Jane Smith' } });
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Bob Jones' } });

    const result = await fetchServiceItems(workspaceId, boardId, { participant: 'all' });

    expect(result).toHaveLength(2);
  });

  it('does not treat participant filter metacharacters as a pattern', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({ workspaceId, boardId, data: { 'Participant Full Name': 'Jane Smith' } });

    const result = await fetchServiceItems(workspaceId, boardId, { participant: 'J.ne' });

    expect(result).toHaveLength(0);
  });

  it('filters on the exact transaction status but treats "all" as no filter', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Transaction Status': 'Delivered - To be claimed and invoiced.' },
    });
    await seedItem({ workspaceId, boardId, data: { 'Transaction Status': 'Cancelled' } });

    const filtered = await fetchServiceItems(workspaceId, boardId, {
      transactionStatusFilter: 'Cancelled',
    });
    expect(filtered.map((r) => r.transactionStatus)).toEqual(['Cancelled']);

    stubFolders(workspaceId, boardId, []);
    const all = await fetchServiceItems(workspaceId, boardId, { transactionStatusFilter: 'all' });
    expect(all).toHaveLength(2);
  });

  it('filters on the scheduled start date window', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Participant Full Name': 'In window',
        'Scheduled Shift Start Date & Time': '2026-03-10T09:00:00.000Z',
      },
    });
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Participant Full Name': 'Out of window',
        'Scheduled Shift Start Date & Time': '2026-06-10T09:00:00.000Z',
      },
    });

    const result = await fetchServiceItems(workspaceId, boardId, {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.map((r) => r.participant)).toEqual(['In window']);
  });

  it('uses the actual end date for a delivered row rather than the scheduled start', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Participant Full Name': 'Delivered late',
        'Transaction Status': 'Delivered - To be claimed and invoiced.',
        'Scheduled Shift Start Date & Time': '2026-02-25T09:00:00.000Z',
        'Actual Shift End Date & Time': '2026-03-02T17:00:00.000Z',
      },
    });

    const result = await fetchServiceItems(workspaceId, boardId, {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });

    expect(result.map((r) => r.participant)).toEqual(['Delivered late']);
  });

  it('sorts newest updated first', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Participant Full Name': 'Older' },
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await seedItem({
      workspaceId,
      boardId,
      data: { 'Participant Full Name': 'Newer' },
      updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    const result = await fetchServiceItems(workspaceId, boardId);

    expect(result.map((r) => r.participant)).toEqual(['Newer', 'Older']);
  });

  it('names the business as the service provider for company workforce delivery', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Business.create({ workspaceId, name: 'Acme Care' });
    stubFolders(workspaceId, boardId, []);
    await seedItem({
      workspaceId,
      boardId,
      data: {
        'Participant Full Name': 'Jane Smith',
        'Delivered by': 'Company Workforce',
      },
    });

    const [row] = await fetchServiceItems(workspaceId, boardId);

    expect(row.serviceProvider).toBe('Acme Care');
  });

  it('returns nothing for a board with no items rather than throwing', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubFolders(workspaceId, boardId, []);

    expect(await fetchServiceItems(workspaceId, boardId)).toEqual([]);
  });
});
