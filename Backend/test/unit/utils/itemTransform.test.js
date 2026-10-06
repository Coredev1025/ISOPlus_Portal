import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  default: {},
}));

const { warn } = await import('../../../src/utils/logger.js');
const {
  transformValue,
  transformItemData,
  transformItems,
  getValueFromTransformedItem,
  getLabelName,
  getLabelNames,
  getReferenceIds,
  getFirstReferenceId,
  parseNumber,
  parseDate,
} = await import('../../../src/utils/itemTransform.js');

const LABELS = [
  { id: 'lbl_open', name: 'Open', color: '#22c55e', position: 1 },
  { id: 'lbl_done', name: 'Done', color: '#3b82f6', position: 2 },
];

/** A value object as ISO+ nests it inside an item payload. */
function valueObject(attribute, data, overrides = {}) {
  return {
    id: `val_${attribute.id || 'x'}`,
    object: 'value',
    item_id: 'itm_1',
    attribute_id: attribute.id,
    board_id: 'brd_jobs',
    deleted: false,
    created_at: '2026-06-01T02:11:00.000Z',
    updated_at: '2026-06-01T02:12:30.000Z',
    data,
    attribute: { object: 'attribute', board_id: 'brd_jobs', primary: false, ...attribute },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('transformValue', () => {
  it('returns null when there is no value or no data', () => {
    expect(transformValue(null)).toBeNull();
    expect(transformValue(undefined)).toBeNull();
    expect(transformValue(valueObject({ id: 'a', name: 'A', type: 'text' }, null))).toBeNull();
    expect(transformValue(valueObject({ id: 'a', name: 'A', type: 'text' }, undefined))).toBeNull();
  });

  it('keeps falsy-but-present data', () => {
    expect(transformValue(valueObject({ id: 'a', name: 'A', type: 'number' }, 0))).toBe(0);
    expect(transformValue(valueObject({ id: 'a', name: 'A', type: 'text' }, ''))).toBe('');
    expect(transformValue(valueObject({ id: 'a', name: 'A', type: 'checkbox' }, false))).toBe(false);
  });

  it('expands a label value through the label settings', () => {
    const value = valueObject(
      { id: 'attr_status', name: 'Status', type: 'label', settings: { labels: LABELS } },
      ['lbl_done'],
    );
    expect(transformValue(value)).toEqual({ id: 'lbl_done', name: 'Done', color: '#3b82f6' });
  });

  it('passes reference, members, checklist, attachment and formula data straight through', () => {
    for (const type of ['reference', 'members', 'checklist', 'attachments', 'formula']) {
      const data = [{ id: 'itm_9', object: 'item', name: 'Linked', board_id: 'brd_x' }];
      expect(transformValue(valueObject({ id: 'a', name: 'A', type }, data))).toBe(data);
    }
  });

  it('narrows a source_folder object to id, name and board_id', () => {
    const data = {
      id: 'fld_active',
      object: 'folder',
      name: 'Active',
      board_id: 'brd_jobs',
      position: 3,
    };
    expect(transformValue(valueObject({ id: 'attr_folder', name: 'Folder', type: 'source_folder' }, data)))
      .toEqual({ id: 'fld_active', name: 'Active', board_id: 'brd_jobs' });
  });

  it('returns source_folder data unchanged when it is not an object with an id', () => {
    const attribute = { id: 'attr_folder', name: 'Folder', type: 'source_folder' };
    expect(transformValue(valueObject(attribute, 'fld_active'))).toBe('fld_active');
    const noId = { name: 'Active' };
    expect(transformValue(valueObject(attribute, noId))).toBe(noId);
  });

  it('returns data unchanged for scalar types, unknown types and a missing attribute', () => {
    for (const type of ['text', 'longtext', 'email', 'number', 'date', 'checkbox', 'created_by', 'created_at', 'updated_at', 'something_new']) {
      expect(transformValue(valueObject({ id: 'a', name: 'A', type }, 'raw'))).toBe('raw');
    }
    expect(transformValue({ data: 'raw' })).toBe('raw');
  });
});

describe('transformItemData', () => {
  it('keys every live value by its attribute name and adds the display name', () => {
    const item = {
      id: 'itm_1',
      object: 'item',
      folder_id: 'fld_active',
      board_id: 'brd_jobs',
      name: '  Deep clean  ',
      values: [
        valueObject({ id: 'attr_service', name: 'Service', type: 'text', primary: true }, 'Deep clean'),
        valueObject({ id: 'attr_status', name: 'Status', type: 'label', settings: { labels: LABELS } }, ['lbl_done']),
        valueObject({ id: 'attr_amount', name: 'Amount', type: 'number' }, 0),
        valueObject({ id: 'attr_notes', name: 'Notes', type: 'longtext' }, null),
        valueObject({ id: 'attr_ghost', name: 'Ghost', type: 'text' }, 'gone', { deleted: true }),
        valueObject({ id: '', name: '', type: 'text' }, 'unkeyed'),
      ],
    };

    expect(transformItemData(item)).toEqual({
      Service: 'Deep clean',
      Status: { id: 'lbl_done', name: 'Done', color: '#3b82f6' },
      Amount: 0,
      _primaryValue: 'Deep clean',
    });
  });

  it('falls back to the primary attribute value when the item has no name', () => {
    const item = {
      id: 'itm_2',
      values: [
        valueObject({ id: 'attr_name', name: 'Full Name', type: 'text', primary: true }, '  Jane Doe  '),
      ],
    };

    expect(transformItemData(item)).toEqual({
      'Full Name': '  Jane Doe  ',
      _primaryValue: 'Jane Doe',
    });
  });

  it('omits _primaryValue when neither the item name nor a primary attribute supplies one', () => {
    const item = {
      id: 'itm_3',
      name: '   ',
      values: [valueObject({ id: 'attr_service', name: 'Service', type: 'text' }, 'Deep clean')],
    };

    expect(transformItemData(item)).toEqual({ Service: 'Deep clean' });
  });

  it('records the time-tracking attribute detected by type', () => {
    const item = {
      id: 'itm_4',
      values: [
        valueObject({ id: 'attr_track', name: 'Time Tracking', type: 'time_tracking' }, [
          { id: 'ts_1', started_at: '2026-06-01T09:00:00.000Z', ended_at: '2026-06-01T11:00:00.000Z' },
        ]),
      ],
    };

    const data = transformItemData(item);
    expect(data._hasTimeTracking).toBe(true);
    expect(data._timeTrackingKey).toBe('Time Tracking');
    expect(data._timeTrackingAttributeId).toBe('attr_track');
  });

  it('returns an empty object and warns when the values array is missing or not an array', () => {
    expect(transformItemData(null)).toEqual({});
    expect(transformItemData({ id: 'itm_5' })).toEqual({});
    expect(transformItemData({ id: 'itm_6', values: 'nope' })).toEqual({});

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenNthCalledWith(1, 'ItemTransform', 'Invalid item data - missing values array', { itemId: undefined });
    expect(warn).toHaveBeenNthCalledWith(3, 'ItemTransform', 'Invalid item data - missing values array', { itemId: 'itm_6' });
  });

  it('throws ReferenceError instead of warning when transforming a value fails', () => {
    // BUG: the catch block calls resolveAttributeKey(), which itemTransform.js
    // never imports, so the recovery path itself throws.
    const exploding = valueObject({ id: 'attr_bad', name: 'Bad', type: 'text' }, null);
    Object.defineProperty(exploding, 'data', {
      get() { throw new Error('boom'); },
      enumerable: true,
      configurable: true,
    });

    expect(() => transformItemData({ id: 'itm_7', values: [exploding] })).toThrow(ReferenceError);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('transformItems', () => {
  it('maps each item to its id, folder and transformed data', () => {
    const items = [
      {
        id: 'itm_1',
        folder_id: 'fld_active',
        name: 'Deep clean',
        values: [valueObject({ id: 'attr_service', name: 'Service', type: 'text' }, 'Deep clean')],
      },
      {
        id: 'itm_2',
        folder_id: 'fld_archive',
        values: [valueObject({ id: 'attr_amount', name: 'Amount', type: 'number' }, 12.5)],
      },
    ];

    expect(transformItems(items)).toEqual([
      { itemId: 'itm_1', folderId: 'fld_active', data: { Service: 'Deep clean', _primaryValue: 'Deep clean' } },
      { itemId: 'itm_2', folderId: 'fld_archive', data: { Amount: 12.5 } },
    ]);
  });

  it('returns an empty array for anything that is not an array', () => {
    expect(transformItems(null)).toEqual([]);
    expect(transformItems(undefined)).toEqual([]);
    expect(transformItems({ id: 'itm_1' })).toEqual([]);
  });

  it('keeps the row with empty data when an item has no values array', () => {
    expect(transformItems([{ id: 'itm_9', folder_id: 'fld_1' }])).toEqual([
      { itemId: 'itm_9', folderId: 'fld_1', data: {} },
    ]);
  });
});

describe('getValueFromTransformedItem', () => {
  it('reads a present attribute, including falsy values', () => {
    const data = { Service: 'Deep clean', Amount: 0, Done: false };
    expect(getValueFromTransformedItem(data, 'Service')).toBe('Deep clean');
    expect(getValueFromTransformedItem(data, 'Amount')).toBe(0);
    expect(getValueFromTransformedItem(data, 'Done')).toBe(false);
  });

  it('returns null for a missing attribute or a non-object item', () => {
    expect(getValueFromTransformedItem({ Service: 'x' }, 'Missing')).toBeNull();
    expect(getValueFromTransformedItem({ Service: null }, 'Service')).toBeNull();
    expect(getValueFromTransformedItem(null, 'Service')).toBeNull();
    expect(getValueFromTransformedItem('not an object', 'Service')).toBeNull();
  });
});

describe('getLabelName', () => {
  it('reads the name from an expanded label, an array of labels or a plain string', () => {
    expect(getLabelName('Done')).toBe('Done');
    expect(getLabelName({ id: 'lbl_done', name: 'Done', color: '#3b82f6' })).toBe('Done');
    expect(getLabelName([{ id: 'lbl_done', name: 'Done' }, { id: 'lbl_open', name: 'Open' }])).toBe('Done');
    expect(getLabelName(['Done', 'Open'])).toBe('Done');
  });

  it('returns null for nullish values, objects without a name and non-label types', () => {
    expect(getLabelName(null)).toBeNull();
    expect(getLabelName(undefined)).toBeNull();
    expect(getLabelName('')).toBeNull();
    expect(getLabelName({ id: 'lbl_done' })).toBeNull();
    expect(getLabelName(7)).toBeNull();
  });

  it('stringifies array entries that are not named objects', () => {
    expect(getLabelName([{ id: 'lbl_done' }])).toBe('[object Object]');
    expect(getLabelName([])).toBe('undefined');
    expect(getLabelName([5])).toBe('5');
  });
});

describe('getLabelNames', () => {
  it('returns every label name', () => {
    expect(getLabelNames([{ id: 'lbl_done', name: 'Done' }, { id: 'lbl_open', name: 'Open' }]))
      .toEqual(['Done', 'Open']);
    expect(getLabelNames(['Done', 'Open'])).toEqual(['Done', 'Open']);
    expect(getLabelNames('Done')).toEqual(['Done']);
    expect(getLabelNames({ id: 'lbl_done', name: 'Done' })).toEqual(['Done']);
  });

  it('returns an empty array for nullish values, empty arrays and unnamed objects', () => {
    expect(getLabelNames(null)).toEqual([]);
    expect(getLabelNames(undefined)).toEqual([]);
    expect(getLabelNames('')).toEqual([]);
    expect(getLabelNames([])).toEqual([]);
    expect(getLabelNames({ id: 'lbl_done' })).toEqual([]);
  });

  it('stringifies array entries that are not named objects', () => {
    expect(getLabelNames([{ id: 'lbl_done' }, 5])).toEqual(['[object Object]', '5']);
  });
});

describe('getReferenceIds / getFirstReferenceId', () => {
  it('stringifies every reference id', () => {
    expect(getReferenceIds(['itm_1', 'itm_2'])).toEqual(['itm_1', 'itm_2']);
    expect(getReferenceIds([1, 2])).toEqual(['1', '2']);
    expect(getReferenceIds('itm_1')).toEqual(['itm_1']);
    expect(getReferenceIds(99)).toEqual(['99']);
  });

  it('returns an empty array for any falsy reference value, including 0', () => {
    expect(getReferenceIds(null)).toEqual([]);
    expect(getReferenceIds(undefined)).toEqual([]);
    expect(getReferenceIds('')).toEqual([]);
    expect(getReferenceIds(0)).toEqual([]);
  });

  it('takes the first id, or null when there is none', () => {
    expect(getFirstReferenceId(['itm_1', 'itm_2'])).toBe('itm_1');
    expect(getFirstReferenceId('itm_1')).toBe('itm_1');
    expect(getFirstReferenceId([])).toBeNull();
    expect(getFirstReferenceId(null)).toBeNull();
  });
});

describe('parseNumber', () => {
  it('returns finite numbers unchanged', () => {
    expect(parseNumber(42.5)).toBe(42.5);
    expect(parseNumber(-7)).toBe(-7);
    expect(parseNumber(0)).toBe(0);
  });

  it('returns 0 for nullish, non-finite and non-numeric types', () => {
    expect(parseNumber(null)).toBe(0);
    expect(parseNumber(undefined)).toBe(0);
    expect(parseNumber(NaN)).toBe(0);
    expect(parseNumber(Infinity)).toBe(0);
    expect(parseNumber(true)).toBe(0);
    expect(parseNumber({ amount: 5 })).toBe(0);
    expect(parseNumber([5])).toBe(0);
  });

  it('strips currency symbols and thousands separators from strings', () => {
    expect(parseNumber('$1,234.56')).toBe(1234.56);
    expect(parseNumber('  -50  ')).toBe(-50);
    expect(parseNumber('12.5 hrs')).toBe(12.5);
  });

  it('returns 0 for strings with no digits', () => {
    expect(parseNumber('')).toBe(0);
    expect(parseNumber('n/a')).toBe(0);
  });

  it('does not treat brackets as negative and stops at an embedded minus', () => {
    expect(parseNumber('(100.25)')).toBe(100.25);
    expect(parseNumber('12-34')).toBe(12);
  });
});

describe('parseDate', () => {
  it('parses ISO strings and epoch numbers', () => {
    expect(parseDate('2026-06-01T09:30:00.000Z').toISOString()).toBe('2026-06-01T09:30:00.000Z');
    expect(parseDate('2026-06-01').toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(parseDate(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('returns the same Date instance when given a valid Date', () => {
    const date = new Date('2026-06-01T09:30:00.000Z');
    expect(parseDate(date)).toBe(date);
  });

  it('returns null for nullish, empty, invalid and unsupported values', () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(new Date('not a date'))).toBeNull();
    expect(parseDate(true)).toBeNull();
    expect(parseDate({ year: 2026 })).toBeNull();
  });
});
