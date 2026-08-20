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
  });

  it('sets a logo key and ships the file the offline store resolves it to', () => {
    // This assertion used to be the reverse — the logo key had to be empty,
    // because a non-empty one made the offline getS3File read throw ENOENT.
    // That is why every locally generated invoice came out with a blank corner
    // while dev's came out with one, and why the missing-branding warning went
    // unexercised. The loader now seeds `localFiles` into .local-s3/, so the
    // key resolves offline and the fixture can carry the real thing.
    const { business } = fixture;
    expect(business.defaultLogo).toBeTruthy();
    expect(fixture.localFiles[business.defaultLogo], business.defaultLogo).toBeTruthy();
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

  // itemId uniqueness and cross-fixture disjointness are checked once, for
  // every fixture pair, in careManagementStatementPermutations.test.js.

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

/**
 * Rows that carry a transaction status but are deliberately not billable.
 *
 * Both reproduce shapes found on the live SaH board, where 19 of 65 rows billed
 * nothing and 16 of those had no participant at all. The generators used to
 * count rows rather than weigh them, so those rows produced a $0.00 invoice
 * that claimed an invoice number and marked every row invoiced — permanently
 * excluding them from future runs. They are named here rather than detected by
 * shape so that deleting one fails this file loudly.
 */
const EDGE_CASE_ITEMS = {
  // Skeleton row: an id, a date and enum defaults, nothing else. No participant
  // to address an invoice to. Must be filtered out before generation.
  '55390000-eeee-4001-8001-000000000001': 'skeleton row with no participant',
  // Belongs to a real participant, but bills nothing. Rides along as a $0.00
  // line on that participant's invoice — correct, because the service record
  // exists. Only an invoice whose *total* is zero is the bug.
  '55390000-eeee-4002-8002-000000000001': 'zero-value row on a real participant',
};

describe('care-management-automation fixture: SaH board (Age Care branch)', () => {
  const withStatus = itemsOn(SAH_BOARD)
    .filter((item) => ATTRIBUTE_NAMES.TRANSACTION_STATUS in item.data);
  const billable = withStatus.filter((item) => !(item.itemId in EDGE_CASE_ITEMS));

  it('has billable service rows', () => {
    expect(billable.length).toBeGreaterThan(1);
  });

  it('carries both zero-value decoys so the value guards are exercised', () => {
    const present = withStatus.filter((item) => item.itemId in EDGE_CASE_ITEMS).map((i) => i.itemId);
    expect(present.sort()).toEqual(Object.keys(EDGE_CASE_ITEMS).sort());
  });

  it('gives the skeleton decoy no participant and nothing to bill', () => {
    const skeleton = withStatus.find((i) => i.itemId === '55390000-eeee-4001-8001-000000000001');
    expect(skeleton.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE] ?? null).toBeFalsy();
    expect(Number(skeleton.data[ATTRIBUTE_NAMES.TOTAL_AMOUNT])).toBe(0);
  });

  it('gives the zero-value decoy a real participant and nothing to bill', () => {
    const zero = withStatus.find((i) => i.itemId === '55390000-eeee-4002-8002-000000000001');
    const refId = extractRefId(zero.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]);
    expect(refMap.get(refId), `zero-value decoy profile ${refId}`).toBeDefined();
    expect(Number(zero.data[ATTRIBUTE_NAMES.TOTAL_AMOUNT])).toBe(0);
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

  it('reconciles each Home Support budget against the rows it bills', () => {
    // The statement draws "Service Delivered" from the budget item and the
    // remaining balance from a second stored field, so nothing in the code
    // makes them agree — the fixture has to. When they disagree the statement
    // contradicts itself: a balance that drops by $397 above a delivered line
    // reading $0.00, which is what sent us looking at "all zeros" in the first
    // place. Home Support only: offline every budget item collapses to HSQ,
    // so the other categories deliberately carry no month.
    const HS_FUNDING = 'Home Support(HS) Quarterly';
    const budgets = itemsOn(SAH_BOARD).filter((i) => i.data.Month === 'January');
    expect(budgets.length).toBeGreaterThan(0);

    for (const budget of budgets) {
      const profileId = extractRefId(budget.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]);
      const delivered = billable
        .filter((i) => extractRefId(i.data[ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]) === profileId)
        .filter((i) => i.data['Funding Source'] === HS_FUNDING)
        .reduce((sum, i) => sum + Number(i.data[ATTRIBUTE_NAMES.TOTAL_AMOUNT] || 0), 0);

      expect(
        Number(budget.data['Home Support Delivered During the Month ($-)']),
        `${budget.itemId} delivered`,
      ).toBe(delivered);

      const available = Number(budget.data['Available Fund at the Start of the Month ($)']);
      expect(
        Number(budget.data['Remaining Home Support Balance as at the End of the Month ($)']),
        `${budget.itemId} remaining`,
      ).toBe(available - delivered);
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
