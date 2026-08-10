import { describe, it, expect, vi } from 'vitest';
import {
  transformLabelValue,
  resolveAttributeKey,
  markTimeTrackingByAttributeType,
  markTimeTrackingFromTransformedValue,
  applyTransformedItemValue,
  processItemValueObject,
  resolveDisplayName,
  applyItemValueTransform,
} from '../../../src/utils/itemTransformHelpers.js';

/** A label attribute as ISO+ expands it on a value object. */
function labelAttribute(labels) {
  return {
    id: 'attr_status',
    object: 'attribute',
    name: 'Status',
    type: 'label',
    primary: false,
    board_id: 'brd_jobs',
    settings: { labels },
  };
}

const LABELS = [
  { id: 'lbl_open', name: 'Open', color: '#22c55e', position: 1 },
  { id: 'lbl_done', name: 'Done', color: '#3b82f6', position: 2 },
];

/** A value object from an ISO+ item payload. */
function valueObject(overrides = {}) {
  return {
    id: 'val_1',
    object: 'value',
    item_id: 'itm_1',
    attribute_id: 'attr_name',
    board_id: 'brd_jobs',
    deleted: false,
    data: 'Deep clean',
    attribute: {
      id: 'attr_name',
      object: 'attribute',
      name: 'Service',
      type: 'text',
      primary: false,
      board_id: 'brd_jobs',
    },
    ...overrides,
  };
}

/** The transformValue collaborator, reduced to the part these helpers rely on. */
const passThroughTransform = (v) => v.data;

describe('transformLabelValue', () => {
  it('resolves a single label id to the full label and unwraps it from the array', () => {
    expect(transformLabelValue(['lbl_done'], labelAttribute(LABELS)))
      .toEqual({ id: 'lbl_done', name: 'Done', color: '#3b82f6' });
  });

  it('resolves several label ids and keeps them as an array', () => {
    expect(transformLabelValue(['lbl_open', 'lbl_done'], labelAttribute(LABELS))).toEqual([
      { id: 'lbl_open', name: 'Open', color: '#22c55e' },
      { id: 'lbl_done', name: 'Done', color: '#3b82f6' },
    ]);
  });

  it('leaves an unknown label id as the bare string', () => {
    expect(transformLabelValue(['lbl_open', 'lbl_ghost'], labelAttribute(LABELS))).toEqual([
      { id: 'lbl_open', name: 'Open', color: '#22c55e' },
      'lbl_ghost',
    ]);
  });

  it('leaves label ids unresolved when the attribute carries no label settings', () => {
    expect(transformLabelValue(['lbl_done'], { id: 'attr_status', type: 'label' })).toBe('lbl_done');
    expect(transformLabelValue(['lbl_done'], undefined)).toBe('lbl_done');
  });

  it('unwraps a single already-expanded label object but keeps several as an array', () => {
    const expanded = [{ id: 'lbl_done', name: 'Done', color: '#3b82f6' }];
    expect(transformLabelValue(expanded, labelAttribute(LABELS))).toBe(expanded[0]);

    const two = [
      { id: 'lbl_open', name: 'Open', color: '#22c55e' },
      { id: 'lbl_done', name: 'Done', color: '#3b82f6' },
    ];
    expect(transformLabelValue(two, labelAttribute(LABELS))).toBe(two);
  });

  it('returns the array untouched when its first entry is neither a string nor an object with an id', () => {
    const noId = [{ name: 'Done' }];
    expect(transformLabelValue(noId, labelAttribute(LABELS))).toBe(noId);

    const numeric = [7, 8];
    expect(transformLabelValue(numeric, labelAttribute(LABELS))).toBe(numeric);
  });

  it('returns an empty array untouched', () => {
    const empty = [];
    expect(transformLabelValue(empty, labelAttribute(LABELS))).toBe(empty);
  });

  it('narrows a single label object to id, name and colour', () => {
    expect(transformLabelValue(
      { id: 'lbl_done', name: 'Done', color: '#3b82f6', position: 2, board_id: 'brd_jobs' },
      labelAttribute(LABELS),
    )).toEqual({ id: 'lbl_done', name: 'Done', color: '#3b82f6' });
  });

  it('returns non-array, non-label-object data unchanged', () => {
    expect(transformLabelValue('Done', labelAttribute(LABELS))).toBe('Done');
    expect(transformLabelValue({ name: 'Done' }, labelAttribute(LABELS))).toEqual({ name: 'Done' });
  });

  it('throws on null data, which is why callers must guard first', () => {
    expect(() => transformLabelValue(null, labelAttribute(LABELS))).toThrow(TypeError);
  });
});

describe('resolveAttributeKey', () => {
  it('uses the trimmed attribute name', () => {
    expect(resolveAttributeKey(valueObject({ attribute: { id: 'a1', name: '  Full Name  ' } })))
      .toBe('Full Name');
  });

  it('falls back to the attribute id when the name is blank or not a string', () => {
    expect(resolveAttributeKey({ attribute: { id: 'attr_9', name: '   ' } })).toBe('__attr_attr_9');
    expect(resolveAttributeKey({ attribute: { id: 42, name: 123 } })).toBe('__attr_42');
    expect(resolveAttributeKey({ attribute: { id: 0 } })).toBe('__attr_0');
  });

  it('returns null when there is neither a usable name nor a usable id', () => {
    expect(resolveAttributeKey({ attribute: { name: '', id: '' } })).toBeNull();
    expect(resolveAttributeKey({ attribute: { name: '', id: '  ' } })).toBeNull();
    expect(resolveAttributeKey({ attribute: {} })).toBeNull();
    expect(resolveAttributeKey({})).toBeNull();
  });
});

describe('markTimeTrackingByAttributeType', () => {
  it('flags time-tracking attribute types in any spelling', () => {
    for (const type of ['time_tracking', 'timetrack', 'timeTracking', 'TIME-TRACK']) {
      const data = {};
      expect(markTimeTrackingByAttributeType(data, { attribute: { id: 'attr_t', type } }, 'Tracked'))
        .toBe(true);
      expect(data).toEqual({
        _hasTimeTracking: true,
        _timeTrackingKey: 'Tracked',
        _timeTrackingAttributeId: 'attr_t',
      });
    }
  });

  it('leaves the data untouched for any other attribute type', () => {
    const data = {};
    expect(markTimeTrackingByAttributeType(data, valueObject(), 'Service')).toBe(false);
    expect(data).toEqual({});
  });

  it('ignores a missing or non-string attribute type', () => {
    expect(markTimeTrackingByAttributeType({}, { attribute: { id: 'a' } }, 'k')).toBe(false);
    expect(markTimeTrackingByAttributeType({}, { attribute: { id: 'a', type: 7 } }, 'k')).toBe(false);
    expect(markTimeTrackingByAttributeType({}, {}, 'k')).toBe(false);
  });

  it('records a null attribute id when the attribute has none', () => {
    const data = {};
    markTimeTrackingByAttributeType(data, { attribute: { type: 'time_tracking' } }, 'Tracked');
    expect(data._timeTrackingAttributeId).toBeNull();
  });
});

describe('markTimeTrackingFromTransformedValue', () => {
  const sessions = [{ id: 'ts_1', started_at: '2026-06-01T09:00:00.000Z', ended_at: '2026-06-01T11:00:00.000Z' }];

  it('flags a value whose first entry carries started_at', () => {
    const data = {};
    expect(markTimeTrackingFromTransformedValue(data, { attribute: { id: 'attr_t' } }, 'Sessions', sessions))
      .toBe(true);
    expect(data).toEqual({
      _hasTimeTracking: true,
      _timeTrackingKey: 'Sessions',
      _timeTrackingAttributeId: 'attr_t',
    });
  });

  it('detects started_at even when its value is null', () => {
    const data = {};
    expect(markTimeTrackingFromTransformedValue(data, { attribute: { id: 'attr_t' } }, 'Sessions', [{ started_at: null }]))
      .toBe(true);
    expect(data._hasTimeTracking).toBe(true);
  });

  it('does not overwrite an already-detected time-tracking attribute', () => {
    const data = { _hasTimeTracking: true, _timeTrackingKey: 'First', _timeTrackingAttributeId: 'attr_first' };
    expect(markTimeTrackingFromTransformedValue(data, { attribute: { id: 'attr_t' } }, 'Sessions', sessions))
      .toBe(false);
    expect(data._timeTrackingKey).toBe('First');
    expect(data._timeTrackingAttributeId).toBe('attr_first');
  });

  it('ignores values that do not have the time-tracking shape', () => {
    const cases = [
      [],
      [{ id: 'x', name: 'no timestamps' }],
      [null],
      ['2026-06-01'],
      { started_at: '2026-06-01T09:00:00.000Z' },
      'started_at',
      null,
    ];
    for (const value of cases) {
      const data = {};
      expect(markTimeTrackingFromTransformedValue(data, { attribute: { id: 'attr_t' } }, 'k', value)).toBe(false);
      expect(data).toEqual({});
    }
  });
});

describe('applyTransformedItemValue', () => {
  it('stores the value and returns no primary value for a non-primary attribute', () => {
    const data = {};
    expect(applyTransformedItemValue(data, valueObject(), 'Service', 'Deep clean')).toBeNull();
    expect(data).toEqual({ Service: 'Deep clean' });
  });

  it('returns the trimmed value as the primary value for a primary string attribute', () => {
    const data = {};
    const valueObj = valueObject({ attribute: { id: 'attr_name', name: 'Name', type: 'text', primary: true } });

    expect(applyTransformedItemValue(data, valueObj, 'Name', '  Deep clean  ')).toBe('Deep clean');
    expect(data.Name).toBe('  Deep clean  ');
  });

  it('returns no primary value when the primary attribute is not a non-blank string', () => {
    const primary = { id: 'attr_n', name: 'N', type: 'number', primary: true };
    const data = {};

    expect(applyTransformedItemValue(data, { attribute: primary }, 'N', 42)).toBeNull();
    expect(applyTransformedItemValue(data, { attribute: primary }, 'Blank', '   ')).toBeNull();
    expect(data).toEqual({ N: 42, Blank: '   ' });
  });

  it('stores falsy-but-present values', () => {
    const data = {};
    applyTransformedItemValue(data, valueObject(), 'Count', 0);
    applyTransformedItemValue(data, valueObject(), 'Flag', false);
    applyTransformedItemValue(data, valueObject(), 'Note', '');
    expect(data).toEqual({ Count: 0, Flag: false, Note: '' });
  });

  it('skips null and undefined values without writing the key', () => {
    const data = {};
    expect(applyTransformedItemValue(data, valueObject(), 'Service', null)).toBeNull();
    expect(applyTransformedItemValue(data, valueObject(), 'Service', undefined)).toBeNull();
    expect(data).toEqual({});
  });

  it('flags time tracking detected from the stored value', () => {
    const data = {};
    applyTransformedItemValue(
      data,
      { attribute: { id: 'attr_t', name: 'Sessions', type: 'unknown' } },
      'Sessions',
      [{ started_at: '2026-06-01T09:00:00.000Z' }],
    );
    expect(data._hasTimeTracking).toBe(true);
    expect(data._timeTrackingKey).toBe('Sessions');
  });
});

describe('processItemValueObject', () => {
  it('stores a transformed value under the attribute name', () => {
    const data = {};
    expect(processItemValueObject(data, valueObject(), passThroughTransform)).toBeNull();
    expect(data).toEqual({ Service: 'Deep clean' });
  });

  it('skips a deleted value object', () => {
    const data = {};
    const transform = vi.fn(passThroughTransform);
    expect(processItemValueObject(data, valueObject({ deleted: true }), transform)).toBeNull();
    expect(data).toEqual({});
    expect(transform).not.toHaveBeenCalled();
  });

  it('skips a value object with no resolvable attribute key', () => {
    const data = {};
    const transform = vi.fn(passThroughTransform);
    expect(processItemValueObject(data, valueObject({ attribute: {} }), transform)).toBeNull();
    expect(data).toEqual({});
    expect(transform).not.toHaveBeenCalled();
  });

  it('returns the primary value for a primary attribute', () => {
    const data = {};
    const valueObj = valueObject({
      data: ' Deep clean ',
      attribute: { id: 'attr_name', name: 'Name', type: 'text', primary: true },
    });
    expect(processItemValueObject(data, valueObj, passThroughTransform)).toBe('Deep clean');
  });

  it('keeps the first time-tracking attribute when a later one also matches by type', () => {
    const data = { _hasTimeTracking: true, _timeTrackingKey: 'First', _timeTrackingAttributeId: 'attr_first' };
    processItemValueObject(
      data,
      { attribute: { id: 'attr_second', name: 'Second', type: 'time_tracking' }, data: [] },
      passThroughTransform,
    );
    expect(data._timeTrackingKey).toBe('First');
    expect(data._timeTrackingAttributeId).toBe('attr_first');
  });

  it('flags time tracking by attribute type before the value is transformed', () => {
    const data = {};
    processItemValueObject(
      data,
      { attribute: { id: 'attr_t', name: 'Tracked', type: 'time_tracking' }, data: null },
      passThroughTransform,
    );
    expect(data).toEqual({
      _hasTimeTracking: true,
      _timeTrackingKey: 'Tracked',
      _timeTrackingAttributeId: 'attr_t',
    });
  });
});

describe('resolveDisplayName', () => {
  it('prefers the trimmed top-level item name', () => {
    expect(resolveDisplayName({ id: 'itm_1', name: '  Deep clean  ' }, 'Primary value')).toBe('Deep clean');
  });

  it('falls back to the primary attribute value when the name is blank or not a string', () => {
    expect(resolveDisplayName({ id: 'itm_1', name: '' }, 'Primary value')).toBe('Primary value');
    expect(resolveDisplayName({ id: 'itm_1', name: '   ' }, 'Primary value')).toBe('Primary value');
    expect(resolveDisplayName({ id: 'itm_1', name: 42 }, 'Primary value')).toBe('Primary value');
    expect(resolveDisplayName({ id: 'itm_1' }, 'Primary value')).toBe('Primary value');
  });

  it('returns null when neither source has a name', () => {
    expect(resolveDisplayName({ id: 'itm_1', name: '   ' }, null)).toBeNull();
    expect(resolveDisplayName({ id: 'itm_1' }, '')).toBeNull();
  });
});

describe('applyItemValueTransform', () => {
  it('stores the transformed value and returns the primary value', () => {
    const data = {};
    const valueObj = valueObject({
      data: ' Deep clean ',
      attribute: { id: 'attr_name', name: 'Name', type: 'text', primary: true },
    });

    expect(applyItemValueTransform(data, valueObj, passThroughTransform)).toBe('Deep clean');
    expect(data).toEqual({ Name: ' Deep clean ' });
  });

  it('skips a value object with no resolvable attribute key', () => {
    const data = {};
    const transform = vi.fn(passThroughTransform);
    expect(applyItemValueTransform(data, { attribute: {} }, transform)).toBeNull();
    expect(transform).not.toHaveBeenCalled();
    expect(data).toEqual({});
  });

  it('skips null and undefined transformed values without writing the key', () => {
    const data = {};
    expect(applyItemValueTransform(data, valueObject({ data: null }), passThroughTransform)).toBeNull();
    expect(applyItemValueTransform(data, valueObject({ data: undefined }), passThroughTransform)).toBeNull();
    expect(data).toEqual({});
  });

  it('does not skip a deleted value object, unlike processItemValueObject', () => {
    const data = {};
    applyItemValueTransform(data, valueObject({ deleted: true }), passThroughTransform);
    expect(data).toEqual({ Service: 'Deep clean' });
  });

  it('flags time tracking by attribute type and by value shape', () => {
    const byType = {};
    applyItemValueTransform(
      byType,
      { attribute: { id: 'attr_t', name: 'Tracked', type: 'time_tracking' }, data: 'x' },
      passThroughTransform,
    );
    expect(byType._timeTrackingKey).toBe('Tracked');

    const byShape = {};
    applyItemValueTransform(
      byShape,
      {
        attribute: { id: 'attr_s', name: 'Sessions', type: 'formula' },
        data: [{ started_at: '2026-06-01T09:00:00.000Z', ended_at: null }],
      },
      passThroughTransform,
    );
    expect(byShape._hasTimeTracking).toBe(true);
    expect(byShape._timeTrackingKey).toBe('Sessions');
    expect(byShape._timeTrackingAttributeId).toBe('attr_s');
  });
});
