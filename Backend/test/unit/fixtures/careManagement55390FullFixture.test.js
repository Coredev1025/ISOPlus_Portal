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
import { ATTRIBUTE_NAMES, REF_ATTRIBUTE_NAMES } from '../../../src/constants/monthlyStatementAttributes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '../../fixtures');
const fixture = JSON.parse(
  readFileSync(path.join(fixturesDir, 'care-management-55390-full.json'), 'utf8'),
);

const SAH_BOARD = 'jpjztrn14pJ';
const NDIS_BOARD = 'o24sGM1FoST';
const NEW_BOARD = 'dwV23F5WcQL';

const itemsOn = (boardId) => fixture.items.filter((item) => item.boardId === boardId);
const refMap = new Map(fixture.items.map((item) => [item.itemId, item]));
// Captured service rows carry a Transaction Status, a scheduled date, or a
// Payment Status; profile / service-plan / funding-source rows carry none.
const isServiceRow = (item) => ATTRIBUTE_NAMES.SCHEDULED_START in item.data
  || ATTRIBUTE_NAMES.TRANSACTION_STATUS in item.data
  || 'Payment Status' in item.data
  || 'Item Purchased Method' in item.data;

describe('care-management-55390-full fixture: captured inventory', () => {
  it('replicates the dev row counts per board', () => {
    expect(itemsOn(SAH_BOARD).filter(isServiceRow)).toHaveLength(65);
    expect(itemsOn(NDIS_BOARD).filter(isServiceRow)).toHaveLength(43);
    expect(itemsOn(NEW_BOARD).filter(isServiceRow)).toHaveLength(3);
  });

  it('reproduces the SaH feed money totals to the cent', () => {
    const rows = itemsOn(SAH_BOARD).filter(isServiceRow);
    const sum = (attr) => Math.round(
      rows.reduce((acc, item) => acc + (Number(item.data[attr]) || 0), 0) * 100,
    ) / 100;
    expect(sum(ATTRIBUTE_NAMES.TOTAL_AMOUNT)).toBe(24587.5);
    expect(sum(ATTRIBUTE_NAMES.GOV_SUBSIDY)).toBe(22319.7);
    expect(sum(ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION)).toBe(1216.5);
  });

  it('replicates the dev participant lists per board', () => {
    const names = (boardId) => new Set(
      itemsOn(boardId)
        .map((item) => String(item.data[REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME] ?? '').trim())
        .filter(Boolean),
    );
    expect([...names(SAH_BOARD)].sort()).toEqual(['David Brown', 'Jane Smith', 'Lisa Morphy']);
    expect([...names(NDIS_BOARD)].sort()).toEqual(
      ['David Smith', 'George Brown', 'Kate Abraham', 'Martin Space', 'Sunil Patel'],
    );
    expect([...names(NEW_BOARD)].sort()).toEqual(['Mike Bird']);
  });

  it('marks the dev-invoiced rows via invoiceNumbers', () => {
    const byNumber = new Map();
    for (const entry of fixture.invoiceNumbers) {
      byNumber.set(entry.invoiceNumber, (byNumber.get(entry.invoiceNumber) ?? 0) + 1);
      expect(refMap.has(entry.itemId), `${entry.itemId} exists as an item`).toBe(true);
    }
    expect(byNumber.get('INV-1002 (ISO+™)')).toBe(4);
    expect(byNumber.get('INV-1003 (ISO+™)')).toBe(1);
  });
});

describe('care-management-55390-full fixture: pipeline safety', () => {
  const approvedMasters = fixture.items.filter(
    (item) => String(item.data[NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL] ?? '')
      .trim().toLowerCase() === 'approved',
  );

  it('only approves rows whose refs resolve, so a future tick can never throw', () => {
    expect(approvedMasters.length).toBeGreaterThan(0);
    for (const master of approvedMasters) {
      for (const refAttr of [
        NDIS_MASTERPLAN_ATTR.PARTICIPANT_PROFILE,
        NDIS_MASTERPLAN_ATTR.SERVICE_PLAN,
      ]) {
        const refId = extractRefId(master.data[refAttr]);
        expect(isUuidLike(refId), `${master.itemId} ${refAttr} "${refId}"`).toBe(true);
        expect(refMap.has(refId), `${master.itemId} ${refAttr} resolves`).toBe(true);
      }
      const plan = refMap.get(extractRefId(master.data[NDIS_MASTERPLAN_ATTR.SERVICE_PLAN]));
      const sentinels = [
        NDIS_SERVICEPLAN_ATTR.ITEM_DIRECT_SUPPORT,
        NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT,
      ].filter((attr) => attr in plan.data);
      expect(sentinels.length, `${plan.itemId} pricing sentinel`).toBe(1);
    }
  });

  // itemId uniqueness and cross-fixture disjointness are checked once, for
  // every fixture pair, in careManagementStatementPermutations.test.js.

  it('declares the three Care Management boards plus the reference carrier, and no schedules', () => {
    // t29GNU4nV2A is dev's real NDIS Library board; it houses the service-plan
    // and funding-source items so the CM lists stay close to dev's counts.
    expect(fixture.boards.map((b) => b.boardId).sort())
      .toEqual([NEW_BOARD, SAH_BOARD, NDIS_BOARD, 't29GNU4nV2A'].sort());
    // Scheduling stays owned by the lean automation fixture; the full replica
    // is data only, so loading it can never arm a tick by itself.
    expect(fixture.scheduledJobs).toBeUndefined();
    expect(fixture.automationSettings).toBeUndefined();
  });
});
