import { describe, it, expect } from 'vitest';
import {
  getDeliveredAmountForCategoryCode,
  buildServiceItemDateQuery,
} from '../../../src/utils/monthlyStatementDeliveredHelpers.js';
import { parseFlexibleNumber } from '../../../src/utils/parseFlexibleNumber.js';
import { ATTRIBUTE_NAMES } from '../../../src/constants/monthlyStatementAttributes.js';

// The three injected helpers below are copied verbatim from the production caller,
// src/services/monthlyStatementData.js, so the logic under test runs against real
// collaborators rather than stubs.
const getValueFromFlatData = (item, attributeName) => {
  if (!item?.data) return null;

  const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];
  for (const attrName of attributeNames) {
    if (item.data[attrName] !== undefined && item.data[attrName] !== null) {
      return item.data[attrName];
    }
  }

  if (Array.isArray(item.data.values)) {
    for (const attrName of attributeNames) {
      const entry = item.data.values.find((v) => v?.attribute?.name === attrName);
      if (entry?.data !== undefined && entry?.data !== null) {
        return entry.data;
      }
    }
  }

  return null;
};

const getValue = (item, attr) => getValueFromFlatData(item, attr);
const parseNumber = parseFlexibleNumber;
const toOutflow = (num) => {
  const n = Number(num);
  if (!Number.isFinite(n) || n === 0) return 0;
  return -Math.abs(n);
};

/** A board item as stored by the sync: flat `data` plus the raw ISO+ `values` array. */
const makeItem = (flatData, extra = {}) => ({
  itemId: extra.itemId ?? 'item-1',
  workspaceId: 'ws-1',
  boardId: 'board-1',
  folderId: extra.folderId ?? 'folder-1',
  updatedAt: extra.updatedAt ?? new Date('2026-04-02T03:00:00.000Z'),
  createdAt: extra.createdAt ?? new Date('2026-03-01T01:00:00.000Z'),
  data: {
    ...flatData,
    values: Object.entries(flatData).map(([name, data], index) => ({
      id: `value-${index}`,
      attribute: { id: `attr-${index}`, name },
      data,
    })),
  },
});

const delivered = (code, item) =>
  getDeliveredAmountForCategoryCode(code, item, getValue, parseNumber, toOutflow);

describe('getDeliveredAmountForCategoryCode', () => {
  it('reads the first ($-) alias for ATS and returns it as an outflow', () => {
    const item = makeItem({
      'AT - Short-term Delivered During the Month ($-)': '1,234.50',
      'Assistive Technology - Short-term Delivered During the Month ($-)': '9,999.00',
      'Assistive Technology - Short-term Delivered During the Month': '7,777.00',
    });
    expect(delivered('ATS', item)).toBe(-1234.5);
  });

  it('falls through to the second ($-) alias for ATS when the first is absent', () => {
    const item = makeItem({
      'Assistive Technology - Short-term Delivered During the Month ($-)': '480.25',
      'Assistive Technology - Short-term Delivered During the Month': '7,777.00',
    });
    expect(delivered('ATS', item)).toBe(-480.25);
  });

  it('falls back to the non-($-) primary attribute for ATS when no minus alias exists', () => {
    const item = makeItem({
      'Assistive Technology - Short-term Delivered During the Month': '312.10',
      'Home Support Delivered During the Month ($-)': '5,000.00',
    });
    expect(delivered('ATS', item)).toBe(-312.1);
  });

  it('stops at a zero ($-) alias instead of falling through to the primary attribute', () => {
    const item = makeItem({
      'AT - Short-term Delivered During the Month ($-)': 0,
      'Assistive Technology - Short-term Delivered During the Month': '500.00',
    });
    expect(delivered('ATS', item)).toBe(0);
  });

  it('stops at an empty-string ($-) alias, which parses to zero', () => {
    const item = makeItem({
      'AT - Short-term Delivered During the Month ($-)': '',
      'Assistive Technology - Short-term Delivered During the Month': '500.00',
    });
    expect(delivered('ATS', item)).toBe(0);
  });

  it('uses the AT - Ongoing attributes for ATO and ignores the short-term ones', () => {
    const item = makeItem({
      'AT - Short-term Delivered During the Month ($-)': '111.00',
      'AT - Ongoing Delivered During the Month ($-)': '222.00',
    });
    expect(delivered('ATO', item)).toBe(-222);
  });

  it('falls through to the second ATO alias, then to the ATO primary', () => {
    const secondAlias = makeItem({
      'Assistive Technology - Ongoing Delivered During the Month ($-)': '333.00',
      'Assistive Technology - Ongoing Delivered During the Month': '444.00',
    });
    expect(delivered('ATO', secondAlias)).toBe(-333);

    const primaryOnly = makeItem({
      'Assistive Technology - Ongoing Delivered During the Month': '444.00',
    });
    expect(delivered('ATO', primaryOnly)).toBe(-444);
  });

  it('uses the Home Modification attributes for HMB', () => {
    const minus = makeItem({
      'Home Modification Delivered During the Month ($-)': '1,000.00',
      'Home Modification Delivered During the Month': '2,000.00',
    });
    expect(delivered('HMB', minus)).toBe(-1000);

    const primary = makeItem({ 'Home Modification Delivered During the Month': '2,000.00' });
    expect(delivered('HMB', primary)).toBe(-2000);
  });

  it('uses the Restorative Care attributes for RCP', () => {
    const minus = makeItem({
      'Restorative Care Delivered During the Month ($-)': '85.75',
      'End-of-Life Care Delivered During the Month ($-)': '999.00',
    });
    expect(delivered('RCP', minus)).toBe(-85.75);

    const primary = makeItem({ 'Restorative Care Delivered During the Month': '60.00' });
    expect(delivered('RCP', primary)).toBe(-60);
  });

  it('uses the End-of-Life attributes for EOL', () => {
    const minus = makeItem({
      'End-of-Life Care Delivered During the Month ($-)': '40.00',
      'Restorative Care Delivered During the Month ($-)': '999.00',
    });
    expect(delivered('EOL', minus)).toBe(-40);

    const primary = makeItem({ 'End-of-Life Care Delivered During the Month': '41.50' });
    expect(delivered('EOL', primary)).toBe(-41.5);
  });

  it('falls back to Home Support attributes for HSQ and for any unmapped code', () => {
    const item = makeItem({
      [ATTRIBUTE_NAMES.HOME_SUPPORT_DELIVERED]: '2,500.75',
      'Restorative Care Delivered During the Month ($-)': '999.00',
    });
    expect(delivered('HSQ', item)).toBe(-2500.75);
    expect(delivered('NOT_A_CODE', item)).toBe(-2500.75);
    expect(delivered(undefined, item)).toBe(-2500.75);
  });

  it('falls back to the non-($-) Home Support attribute when the ($-) one is absent', () => {
    const item = makeItem({ 'Home Support Delivered During the Month': '75.20' });
    expect(delivered('HSQ', item)).toBe(-75.2);
  });

  it('returns 0 when the item carries no delivered attribute at all', () => {
    const item = makeItem({ 'Available Fund at the Start of the Month ($)': '1000.00' });
    expect(delivered('HSQ', item)).toBe(0);
    expect(delivered('ATS', item)).toBe(0);
    expect(delivered('RCP', item)).toBe(0);
  });

  it('normalises an already-negative board value to a single negative (never double-negates)', () => {
    const item = makeItem({ 'Home Support Delivered During the Month ($-)': '-300.00' });
    expect(delivered('HSQ', item)).toBe(-300);
  });

  it('reads from the ISO+ values[] array when the flat key is missing', () => {
    const item = {
      itemId: 'item-values-only',
      workspaceId: 'ws-1',
      boardId: 'board-1',
      folderId: 'folder-1',
      updatedAt: new Date('2026-04-02T03:00:00.000Z'),
      createdAt: new Date('2026-03-01T01:00:00.000Z'),
      data: {
        values: [
          { id: 'v1', attribute: { id: 'a1', name: 'Month' }, data: 'March' },
          {
            id: 'v2',
            attribute: { id: 'a2', name: 'Home Support Delivered During the Month ($-)' },
            data: '640.40',
          },
        ],
      },
    };
    expect(delivered('HSQ', item)).toBe(-640.4);
  });

  it('returns 0 for an item with no data property', () => {
    expect(delivered('HSQ', { itemId: 'x' })).toBe(0);
  });
});

describe('buildServiceItemDateQuery', () => {
  const scheduledKey = `data.${ATTRIBUTE_NAMES.SCHEDULED_START}`;
  const actualEndKey = `data.${ATTRIBUTE_NAMES.ACTUAL_END}`;

  it('returns null when neither bound is supplied', () => {
    expect(buildServiceItemDateQuery(null, null, scheduledKey, actualEndKey)).toBeNull();
    expect(buildServiceItemDateQuery(undefined, undefined, scheduledKey, actualEndKey)).toBeNull();
  });

  it('builds six $or clauses covering both the ISO-string and Date storage forms', () => {
    const startD = new Date('2026-03-01T00:00:00.000Z');
    const endD = new Date('2026-03-31T23:59:59.999Z');

    expect(buildServiceItemDateQuery(startD, endD, scheduledKey, actualEndKey)).toEqual({
      $or: [
        {
          'data.Scheduled Shift Start Date & Time': {
            $gte: '2026-03-01T00:00:00.000Z',
            $lte: '2026-03-31T23:59:59.999Z',
          },
        },
        {
          'data.Scheduled Shift Start Date & Time': {
            $gte: new Date('2026-03-01T00:00:00.000Z'),
            $lte: new Date('2026-03-31T23:59:59.999Z'),
          },
        },
        {
          'data.Actual Shift End Date & Time': {
            $gte: '2026-03-01T00:00:00.000Z',
            $lte: '2026-03-31T23:59:59.999Z',
          },
        },
        {
          'data.Actual Shift End Date & Time': {
            $gte: new Date('2026-03-01T00:00:00.000Z'),
            $lte: new Date('2026-03-31T23:59:59.999Z'),
          },
        },
        {
          updatedAt: {
            $gte: new Date('2026-03-01T00:00:00.000Z'),
            $lte: new Date('2026-03-31T23:59:59.999Z'),
          },
        },
        {
          createdAt: {
            $gte: new Date('2026-03-01T00:00:00.000Z'),
            $lte: new Date('2026-03-31T23:59:59.999Z'),
          },
        },
      ],
    });
  });

  it('omits $lte entirely when only a start bound is given', () => {
    const startD = new Date('2026-03-01T00:00:00.000Z');
    const query = buildServiceItemDateQuery(startD, null, scheduledKey, actualEndKey);

    expect(query.$or).toHaveLength(6);
    expect(query.$or[0][scheduledKey]).toEqual({ $gte: '2026-03-01T00:00:00.000Z' });
    expect(query.$or[1][scheduledKey]).toEqual({ $gte: startD });
    expect(query.$or[4].updatedAt).toEqual({ $gte: startD });
    expect(Object.keys(query.$or[0][scheduledKey])).toEqual(['$gte']);
    expect(Object.keys(query.$or[4].updatedAt)).toEqual(['$gte']);
  });

  it('omits $gte entirely when only an end bound is given', () => {
    const endD = new Date('2026-03-31T23:59:59.999Z');
    const query = buildServiceItemDateQuery(null, endD, scheduledKey, actualEndKey);

    expect(query.$or[2][actualEndKey]).toEqual({ $lte: '2026-03-31T23:59:59.999Z' });
    expect(query.$or[3][actualEndKey]).toEqual({ $lte: endD });
    expect(query.$or[5].createdAt).toEqual({ $lte: endD });
    expect(Object.keys(query.$or[3][actualEndKey])).toEqual(['$lte']);
  });

  it('uses the caller-supplied field keys rather than hard-coded ones', () => {
    const query = buildServiceItemDateQuery(
      new Date('2026-03-01T00:00:00.000Z'),
      null,
      'data.Custom Start',
      'data.Custom End',
    );
    expect(Object.keys(query.$or[0])).toEqual(['data.Custom Start']);
    expect(Object.keys(query.$or[2])).toEqual(['data.Custom End']);
  });

  it('keeps updatedAt/createdAt on Date bounds, never on the ISO-string bounds', () => {
    const startD = new Date('2026-03-01T00:00:00.000Z');
    const endD = new Date('2026-03-31T23:59:59.999Z');
    const query = buildServiceItemDateQuery(startD, endD, scheduledKey, actualEndKey);

    expect(query.$or[4].updatedAt.$gte).toBeInstanceOf(Date);
    expect(query.$or[5].createdAt.$lte).toBeInstanceOf(Date);
    expect(typeof query.$or[0][scheduledKey].$gte).toBe('string');
  });
});
