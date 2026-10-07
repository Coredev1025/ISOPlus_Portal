import { describe, it, expect, vi } from 'vitest';
import {
  valueReferencesId,
  itemDataReferencesId,
  resolveWebhookTransformedValue,
  describeHookPayloadShape,
} from '../../../src/utils/isoplusWebhookHelpers.js';
import { transformValue } from '../../../src/utils/itemTransform.js';

/** A reference entry as ISO+ expands it inside an item's value data. */
const referenceEntry = (id, name) => ({
  id,
  object: 'item',
  name,
  board_id: 'brd_clients',
  folder_id: 'fld_active',
});

/** A value.updated webhook payload, shaped like the real ISO+ event body. */
function valuePayload(overrides = {}) {
  return {
    id: 'val_9f2',
    object: 'value',
    item_id: 'itm_3312',
    attribute_id: 'attr_status',
    board_id: 'brd_jobs',
    workspace_id: 'wsp_1',
    deleted: false,
    created_at: '2026-08-01T02:11:00.000Z',
    updated_at: '2026-08-01T02:12:30.000Z',
    data: 'Delivered',
    attribute: {
      id: 'attr_status',
      object: 'attribute',
      name: 'Status',
      type: 'text',
      primary: false,
      board_id: 'brd_jobs',
    },
    ...overrides,
  };
}

describe('valueReferencesId', () => {
  it('returns false for null and undefined values', () => {
    expect(valueReferencesId(null, 'itm_1')).toBe(false);
    expect(valueReferencesId(undefined, 'itm_1')).toBe(false);
  });

  it('matches a plain string value', () => {
    expect(valueReferencesId('itm_1', 'itm_1')).toBe(true);
    expect(valueReferencesId('itm_2', 'itm_1')).toBe(false);
  });

  it('does not match a number against its string form', () => {
    expect(valueReferencesId(4471, '4471')).toBe(false);
  });

  it('matches a string inside an array', () => {
    expect(valueReferencesId(['itm_9', 'itm_1'], 'itm_1')).toBe(true);
    expect(valueReferencesId(['itm_9', 'itm_8'], 'itm_1')).toBe(false);
  });

  it('matches an expanded reference object inside an array', () => {
    const value = [referenceEntry('itm_9', 'Acme'), referenceEntry('itm_1', 'Bianca R')];
    expect(valueReferencesId(value, 'itm_1')).toBe(true);
    expect(valueReferencesId(value, 'itm_7')).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(valueReferencesId([], 'itm_1')).toBe(false);
  });

  it('tolerates null entries inside an array', () => {
    expect(valueReferencesId([null, 'itm_1'], 'itm_1')).toBe(true);
    expect(valueReferencesId([null, undefined], 'itm_1')).toBe(false);
  });

  it('matches a single expanded reference object', () => {
    expect(valueReferencesId(referenceEntry('itm_1', 'Bianca R'), 'itm_1')).toBe(true);
    expect(valueReferencesId(referenceEntry('itm_2', 'Bianca R'), 'itm_1')).toBe(false);
  });

  it('returns false for an object without an id', () => {
    expect(valueReferencesId({ name: 'Bianca R' }, 'itm_1')).toBe(false);
  });

  it('returns false for booleans and numbers', () => {
    expect(valueReferencesId(true, 'itm_1')).toBe(false);
    expect(valueReferencesId(0, 'itm_1')).toBe(false);
  });
});

describe('itemDataReferencesId', () => {
  const itemData = {
    'Job Title': 'Weekly support',
    Participant: [referenceEntry('itm_1', 'Bianca R')],
    Hours: 3,
    Notes: null,
    _primaryValue: 'Weekly support',
  };

  it('returns false for nullish or non-object item data', () => {
    expect(itemDataReferencesId(null, 'itm_1')).toBe(false);
    expect(itemDataReferencesId(undefined, 'itm_1')).toBe(false);
    expect(itemDataReferencesId('itm_1', 'itm_1')).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(itemDataReferencesId({}, 'itm_1')).toBe(false);
  });

  it('finds the id in a reference array on any key', () => {
    expect(itemDataReferencesId(itemData, 'itm_1')).toBe(true);
  });

  it('returns false when no value references the id', () => {
    expect(itemDataReferencesId(itemData, 'itm_999')).toBe(false);
  });

  it('finds the id held as a bare string value', () => {
    expect(itemDataReferencesId({ 'Linked Job': 'itm_44', Hours: 2 }, 'itm_44')).toBe(true);
  });
});

describe('resolveWebhookTransformedValue', () => {
  it('returns null for a deleted value without transforming or warning', () => {
    const transform = vi.fn();
    const warn = vi.fn();
    const payload = valuePayload({ deleted: true });

    expect(resolveWebhookTransformedValue(payload, true, transform, warn)).toBeNull();
    expect(transform).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('transforms a normal (non-label) value', () => {
    const warn = vi.fn();
    const payload = valuePayload({ data: 'Delivered' });

    expect(resolveWebhookTransformedValue(payload, false, transformValue, warn)).toBe('Delivered');
    expect(warn).not.toHaveBeenCalled();
  });

  it('transforms a label value when the label metadata is present', () => {
    const warn = vi.fn();
    const payload = valuePayload({
      data: ['lbl_appr'],
      attribute: {
        id: 'attr_state',
        object: 'attribute',
        name: 'State',
        type: 'label',
        primary: false,
        board_id: 'brd_jobs',
        settings: {
          labels: [
            { id: 'lbl_appr', name: 'Approved', color: '#22c55e' },
            { id: 'lbl_rej', name: 'Rejected', color: '#ef4444' },
          ],
        },
      },
    });

    expect(resolveWebhookTransformedValue(payload, false, transformValue, warn)).toEqual({
      id: 'lbl_appr',
      name: 'Approved',
      color: '#22c55e',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('stores raw data and warns when a label payload carries no labels', () => {
    const transform = vi.fn();
    const warn = vi.fn();
    const payload = valuePayload({
      data: ['lbl_appr'],
      attribute: {
        id: 'attr_state',
        object: 'attribute',
        name: 'State',
        type: 'label',
        primary: false,
        board_id: 'brd_jobs',
      },
    });

    expect(resolveWebhookTransformedValue(payload, false, transform, warn)).toEqual(['lbl_appr']);
    expect(transform).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Webhook-Handler',
      'Incomplete label metadata in webhook payload, storing raw data',
      { itemId: 'itm_3312', attributeName: 'State', attributeType: 'label' },
    );
  });

  it('warns when a label attribute has settings but no labels array', () => {
    const transform = vi.fn();
    const warn = vi.fn();
    const payload = valuePayload({
      data: ['lbl_appr'],
      attribute: {
        id: 'attr_state',
        name: 'State',
        type: 'label',
        settings: { allow_multiple: true },
      },
    });

    expect(resolveWebhookTransformedValue(payload, false, transform, warn)).toEqual(['lbl_appr']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('transforms when the payload carries no attribute at all', () => {
    const warn = vi.fn();
    const payload = valuePayload({ attribute: undefined, data: 'raw text' });

    expect(resolveWebhookTransformedValue(payload, false, transformValue, warn)).toBe('raw text');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the transform result even when it is null', () => {
    const warn = vi.fn();
    const payload = valuePayload({ data: null });

    expect(resolveWebhookTransformedValue(payload, false, transformValue, warn)).toBeNull();
  });

  it('passes the whole payload to the transform function', () => {
    const transform = vi.fn().mockReturnValue('transformed');
    const warn = vi.fn();
    const payload = valuePayload();

    expect(resolveWebhookTransformedValue(payload, false, transform, warn)).toBe('transformed');
    expect(transform).toHaveBeenCalledWith(payload);
  });
});

describe('describeHookPayloadShape', () => {
  it('reports the keys and which ids are present, never any values', () => {
    expect(describeHookPayloadShape({ id: 'v1', item_id: 'i1', attribute_id: 'a1', data: 'secret' })).toEqual({
      payloadKeys: ['id', 'item_id', 'attribute_id', 'data'],
      hasBoardId: false,
      hasWorkspaceId: false,
      hasItemId: true,
    });
    expect(describeHookPayloadShape({ id: 'i1', board_id: 'b1', workspace_id: 'w1' })).toMatchObject({
      hasBoardId: true,
      hasWorkspaceId: true,
      hasItemId: true,
    });
  });

  it('treats null ids as absent and tolerates a missing payload', () => {
    expect(describeHookPayloadShape({ board_id: null, workspace_id: '' })).toMatchObject({
      hasBoardId: false,
      hasWorkspaceId: false,
      hasItemId: false,
    });
    expect(describeHookPayloadShape(undefined)).toEqual({
      payloadKeys: [],
      hasBoardId: false,
      hasWorkspaceId: false,
      hasItemId: false,
    });
  });
});
