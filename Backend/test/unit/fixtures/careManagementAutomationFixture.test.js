import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NDIS_MASTERPLAN_ATTR,
  NDIS_SERVICEPLAN_ATTR,
  isUuidLike,
  extractRefId,
} from '../../../src/utils/ndisServiceRecords.js';
import { ATTRIBUTE_NAMES } from '../../../src/constants/monthlyStatementAttributes.js';
import {
  isNdisBoardLabel,
  canGenerateMonthlyStatement,
} from '../../../src/utils/automationBoardFlags.js';
import { schedulePeriodServiceDeliveryWindow } from '../../../src/utils/automationScheduleWindow.js';
import { automationPeriodKey } from '../../../src/utils/automationPeriodKey.js';
import { collectNdisInvoiceRows } from '../../../src/utils/ndisInvoiceGeneratorPdfHelpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '../../fixtures');
const fixture = JSON.parse(
  readFileSync(path.join(fixturesDir, 'care-management-automation.json'), 'utf8'),
);
const quoteFixture = JSON.parse(
  readFileSync(path.join(fixturesDir, 'ndis-quote-board.json'), 'utf8'),
);

const WORKSPACE_ID = '55390';
const SAH_BOARD = 'jpjztrn14pJ';
const NDIS_BOARD = 'o24sGM1FoST';
const NEW_BOARD = 'dwV23F5WcQL';

const invoiceJob = fixture.scheduledJobs.find((j) => j.kind === 'invoice_automation');
const statementJob = fixture.scheduledJobs.find((j) => j.kind === 'statement_automation');
const slot = new Date(invoiceJob.nextRunAt);
const window = schedulePeriodServiceDeliveryWindow(slot, invoiceJob.timezone, invoiceJob.schedule);

const itemsOn = (boardId) => fixture.items.filter((item) => item.boardId === boardId);
const refMap = new Map(fixture.items.map((item) => [item.itemId, item]));

function withinWindow(raw) {
  const t = new Date(raw).getTime();
  return (
    t >= new Date(window.serviceDeliveryStart).getTime()
    && t <= new Date(window.serviceDeliveryEnd).getTime()
  );
}

const isApproved = (item) => String(item.data[NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL] ?? '')
  .trim().toLowerCase() === 'approved';
const masterItemsOn = (boardId) => itemsOn(boardId)
  .filter((item) => NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL in item.data);

describe('care-management-automation fixture: workspace and boards', () => {
  it('seeds business 55390 with the automation feature toggle on', () => {
    expect(fixture.business.workspaceId).toBe(WORKSPACE_ID);
    expect(fixture.business.featureToggles.invoiceStatementAutomation).toBe(true);
  });

  it('gives the business every field the PDF generators dereference unguarded', () => {
    const { business } = fixture;
    for (const key of ['street', 'suburb', 'state', 'postcode', 'country']) {
      expect(business.address[key], `address.${key}`).toBeTruthy();
    }
    for (const key of ['accountName', 'bankName', 'bsb', 'accountNumber']) {
      expect(business.bankDetails[key], `bankDetails.${key}`).toBeTruthy();
    }
    expect(business.bankDetails.accountsReceivableTerms).toMatch(/\d+/);
    expect(business.documentNumbering.invoice.prefix).toBeTruthy();
    expect(business.documentNumbering.invoice.nextNumber).toBeGreaterThan(0);
    expect(business.headOfficeTimezone).toBe('Australia/Sydney');
    // A non-empty logo key would make the offline getS3File read throw ENOENT.
    expect(business.defaultLogo ?? '').toBe('');
  });

  it('declares the three live boards with their real ids, labels, and workspace', () => {
    const byId = new Map(fixture.boards.map((b) => [b.boardId, b]));
    expect([...byId.keys()].sort()).toEqual([NEW_BOARD, SAH_BOARD, NDIS_BOARD].sort());
    for (const board of fixture.boards) {
      expect(board.workspaceId, `${board.boardId} workspaceId`).toBe(WORKSPACE_ID);
    }
    expect(byId.get(SAH_BOARD).label).toBe('Care Management - SaH');
    expect(byId.get(NDIS_BOARD).label).toBe('Care Management - NDIS - Certification');
    expect(byId.get(NEW_BOARD).label).toBe('Care Management - NDIS - Certification');
  });

  it('routes each board down the intended generator branch', () => {
    const byId = new Map(fixture.boards.map((b) => [b.boardId, b]));
    expect(isNdisBoardLabel(byId.get(SAH_BOARD).label)).toBe(false);
    expect(isNdisBoardLabel(byId.get(NDIS_BOARD).label)).toBe(true);
    expect(isNdisBoardLabel(byId.get(NEW_BOARD).label)).toBe(true);
    for (const board of fixture.boards) {
      expect(canGenerateMonthlyStatement(board.label), `${board.boardId} statements`).toBe(true);
    }
  });
});

describe('care-management-automation fixture: schedules and settings', () => {
  it('carries both automation kinds, due, picker-scheduled, targeting the workspace', () => {
    for (const job of [invoiceJob, statementJob]) {
      expect(job).toBeDefined();
      expect(job.targetId).toBe(WORKSPACE_ID);
      expect(job.enabled).toBe(true);
      expect(job.cron ?? null).toBeNull();
      expect(job.schedule.every).toEqual({ n: 1, unit: 'month' });
      expect(Number.isNaN(new Date(job.nextRunAt).getTime())).toBe(false);
    }
  });

  it('mints the documented period key for the fixture slot', () => {
    expect(automationPeriodKey({ slot, timezone: invoiceJob.timezone })).toBe('20250201-0900');
  });

  it('enables both settings blocks with a reply-to address', () => {
    for (const block of [fixture.automationSettings.invoice, fixture.automationSettings.statement]) {
      expect(block.enabled).toBe(true);
      expect(block.replyTo).toContain('@');
    }
  });
});

describe('care-management-automation fixture: item integrity', () => {
  it('assigns every item to a declared board with a folderId', () => {
    const boardIds = new Set(fixture.boards.map((b) => b.boardId));
    for (const item of fixture.items) {
      expect(boardIds.has(item.boardId), `${item.itemId} boardId`).toBe(true);
      expect(item.folderId, `${item.itemId} folderId`).toBeTruthy();
    }
  });

  it('keeps itemIds unique here and disjoint from the quote fixture', () => {
    const ids = fixture.items.map((item) => item.itemId);
    expect(new Set(ids).size).toBe(ids.length);
    const quoteIds = new Set(quoteFixture.items.map((item) => item.itemId));
    for (const id of ids) {
      expect(quoteIds.has(id), `${id} collides with ndis-quote-board.json`).toBe(false);
    }
  });

  it('gives every board a participant the statement scan will find', () => {
    for (const boardId of [SAH_BOARD, NDIS_BOARD, NEW_BOARD]) {
      const named = itemsOn(boardId)
        .filter((item) => String(item.data[ATTRIBUTE_NAMES.FULL_NAME] ?? '').trim());
      expect(named.length, `${boardId} statement participants`).toBeGreaterThan(0);
    }
  });
});

describe.each([
  ['legacy pricing', NDIS_BOARD, NDIS_SERVICEPLAN_ATTR.ITEM_DIRECT_SUPPORT],
  ['2026 pricing', NEW_BOARD, NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT],
])('care-management-automation fixture: NDIS board (%s)', (_label, boardId, sentinelAttr) => {
  const approvedMasters = masterItemsOn(boardId).filter(isApproved);

  it('has at least one approved master plan item', () => {
    expect(approvedMasters.length).toBeGreaterThan(0);
  });

  it('keeps approved masters inside the billed window with UUID refs resolving in-fixture', () => {
    for (const master of approvedMasters) {
      const start = master.data[NDIS_MASTERPLAN_ATTR.ACTUAL_START];
      expect(withinWindow(start), `${master.itemId} actual start ${start}`).toBe(true);
      for (const refAttr of [
        NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE,
        NDIS_MASTERPLAN_ATTR.SERVICE_PLAN,
      ]) {
        const refId = extractRefId(master.data[refAttr]);
        expect(isUuidLike(refId), `${master.itemId} ${refAttr} "${refId}"`).toBe(true);
        expect(refMap.has(refId), `${master.itemId} ${refAttr} resolves`).toBe(true);
      }
    }
  });

  it('pins the pricing rule on every referenced service plan via the sentinel key', () => {
    for (const master of approvedMasters) {
      const plan = refMap.get(extractRefId(master.data[NDIS_MASTERPLAN_ATTR.SERVICE_PLAN]));
      expect(sentinelAttr in plan.data, `${plan.itemId} carries ${sentinelAttr}`).toBe(true);
    }
  });

  it('produces billable rows through the real invoice row builder', async () => {
    const byProfile = new Map();
    for (const master of approvedMasters) {
      const profileId = extractRefId(master.data[NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE]);
      if (!byProfile.has(profileId)) byProfile.set(profileId, []);
      byProfile.get(profileId).push(master);
    }
    for (const [profileId, masterItems] of byProfile) {
      const profileItem = refMap.get(profileId);
      expect(profileItem.data[ATTRIBUTE_NAMES.FULL_NAME]).toBeTruthy();
      expect(profileItem.data['NDIS Number']).toBeTruthy();
      const rows = await collectNdisInvoiceRows({
        masterItems,
        refItemsMap: refMap,
        participantName: profileItem.data[ATTRIBUTE_NAMES.FULL_NAME],
        profileItem,
        invoiceNumber: 'INV-CONTRACT-TEST',
        timezone: 'Australia/Sydney',
        workspaceId: WORKSPACE_ID,
        boardId,
      });
      expect(rows.length, `${profileId} rows`).toBeGreaterThan(0);
      const total = rows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0);
      expect(total, `${profileId} billed total`).toBeGreaterThan(0);
    }
  });

  it('carries an unapproved decoy so the eligibility filter is exercised', () => {
    const unapproved = masterItemsOn(boardId).filter((item) => !isApproved(item));
    if (boardId !== NDIS_BOARD) return;
    expect(unapproved.length).toBeGreaterThan(0);
  });
});

describe('care-management-automation fixture: SaH board (Age Care branch)', () => {
  const billable = itemsOn(SAH_BOARD)
    .filter((item) => ATTRIBUTE_NAMES.TRANSACTION_STATUS in item.data);

  it('has billable service rows', () => {
    expect(billable.length).toBeGreaterThan(1);
  });

  it('gives each billable row the fields the tax invoice lines read, inside the window', () => {
    for (const item of billable) {
      const end = item.data[ATTRIBUTE_NAMES.ACTUAL_END];
      expect(withinWindow(end), `${item.itemId} actual end ${end}`).toBe(true);
      expect(Number(item.data[ATTRIBUTE_NAMES.QUANTITY])).toBeGreaterThan(0);
      expect(Number(item.data[ATTRIBUTE_NAMES.UNIT_PRICE])).toBeGreaterThan(0);
      expect(Number(item.data[ATTRIBUTE_NAMES.TOTAL_AMOUNT])).not.toBe(0);
      expect(item.data[ATTRIBUTE_NAMES.UNIT]).toBeTruthy();
    }
  });

  it('resolves each billable row to a profile with billing details', () => {
    for (const item of billable) {
      const refId = extractRefId(item.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]);
      const profile = refMap.get(refId);
      expect(profile, `${item.itemId} profile ${refId}`).toBeDefined();
      expect(profile.data[ATTRIBUTE_NAMES.FULL_NAME]).toBeTruthy();
      expect(profile.data['Billing Contact']).toBeTruthy();
      expect(profile.data['Billing Address']).toBeTruthy();
    }
  });
});
