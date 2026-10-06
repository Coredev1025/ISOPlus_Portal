import { describe, it, expect } from 'vitest';
import {
  normalizeServiceIdString,
  lookupServiceIdFromRefs,
  normalizeHealthProfessionalTypeOther,
  lookupHealthProfessionalFromRef,
} from '../../../src/utils/exportOptimizedServicePlanHelpers.js';

/*
 * The four accessors below are copies of the ones routes/exportOptimized.js
 * passes in, so the helpers are exercised against the real call shapes.
 */
const getValue = (item, attributeName) => {
  if (!item?.data) return null;
  return item.data[attributeName] ?? null;
};

const getValueMulti = (item, attributeNames) => {
  if (!item?.data) return null;
  const names = Array.isArray(attributeNames) ? attributeNames : [attributeNames];
  for (const name of names) {
    if (item.data[name] !== undefined && item.data[name] !== null) {
      return item.data[name];
    }
  }
  return null;
};

const extractRefId = (value) => {
  if (!value) return null;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === 'object' && first.id) return first.id.toString();
    if (typeof first === 'string') return first;
    return first?.toString();
  }
  if (typeof value === 'object' && value.id) return value.id.toString();
  if (typeof value === 'string') return value;
  return value?.toString();
};

const SERVICE_REF_ATTRS = [
  'Home Support (HS)',
  'Assistive Technology (AT) - Short Term',
  'Assistive Technology (AT) - Ongoing',
  'Home Modification (HM)',
  'Health Professional',
];

const ID_ATTRS = [
  'Service ID / Item ID',
  'Service ID /  Item ID',
  'Service ID/Item ID',
];

/** A cached ISO+ item as stored in Mongo and re-hydrated into refItemsMap. */
const refItem = (id, data) => ({
  id,
  board_id: 'board-1',
  name: data['Service'] || 'Ref item',
  data,
});

describe('normalizeServiceIdString', () => {
  it('keeps only the part before the slash, trimmed', () => {
    expect(normalizeServiceIdString('HS_DPC_01 / IT_HS_001')).toBe('HS_DPC_01');
    expect(normalizeServiceIdString('AT001 /ITEM99')).toBe('AT001');
    expect(normalizeServiceIdString('  HS01  /  x  ')).toBe('HS01');
  });

  it('returns the id unchanged when there is no slash', () => {
    expect(normalizeServiceIdString('HS_DPC_01')).toBe('HS_DPC_01');
  });

  it('does not trim when there is no slash', () => {
    // The trim only runs inside the slash branch.
    expect(normalizeServiceIdString('  HS01  ')).toBe('  HS01  ');
  });

  it('stringifies non-string ids', () => {
    expect(normalizeServiceIdString(12345)).toBe('12345');
  });

  it('stringifies nullish input rather than returning it', () => {
    // Callers guard with `if (serviceId)` before calling, so this is documented, not relied on.
    expect(normalizeServiceIdString(null)).toBe('null');
    expect(normalizeServiceIdString(undefined)).toBe('undefined');
  });

  it('returns an empty string for an empty id', () => {
    expect(normalizeServiceIdString('')).toBe('');
  });

  it('takes only the first segment when there are several slashes', () => {
    expect(normalizeServiceIdString('A / B / C')).toBe('A');
  });
});

describe('lookupServiceIdFromRefs', () => {
  it('returns the normalized service id from the first resolvable reference', () => {
    const servicePlanItem = refItem('sp-1', {
      'Home Modification (HM)': [{ id: 'hm-9' }],
    });
    const refItemsMap = new Map([
      ['hm-9', refItem('hm-9', { Service: 'Ramp install', 'Service ID /  Item ID': 'HM_RAMP_01 / IT_HM_007' })],
    ]);

    expect(lookupServiceIdFromRefs(
      servicePlanItem, refItemsMap, SERVICE_REF_ATTRS, getValue, getValueMulti, extractRefId, ID_ATTRS,
    )).toBe('HM_RAMP_01');
  });

  it('skips reference attributes that are absent on the service plan item', () => {
    const servicePlanItem = refItem('sp-1', {
      'Health Professional': 'hp-3',
      'Some Unrelated Attribute': 'ignored',
    });
    const refItemsMap = new Map([
      ['hp-3', refItem('hp-3', { Service: 'Physio assessment', 'Service ID/Item ID': 'HP_PHYS_02' })],
    ]);

    expect(lookupServiceIdFromRefs(
      servicePlanItem, refItemsMap, SERVICE_REF_ATTRS, getValue, getValueMulti, extractRefId, ID_ATTRS,
    )).toBe('HP_PHYS_02');
  });

  it('skips a reference whose target item is not in the map and uses the next one', () => {
    const servicePlanItem = refItem('sp-1', {
      'Home Support (HS)': [{ id: 'hs-missing' }],
      'Home Modification (HM)': [{ id: 'hm-9' }],
    });
    const refItemsMap = new Map([
      ['hm-9', refItem('hm-9', { Service: 'Ramp install', 'Service ID /  Item ID': 'HM_RAMP_01' })],
    ]);

    expect(lookupServiceIdFromRefs(
      servicePlanItem, refItemsMap, SERVICE_REF_ATTRS, getValue, getValueMulti, extractRefId, ID_ATTRS,
    )).toBe('HM_RAMP_01');
  });

  it('skips a resolvable reference that carries no service id and uses the next one', () => {
    const servicePlanItem = refItem('sp-1', {
      'Home Support (HS)': [{ id: 'hs-1' }],
      'Assistive Technology (AT) - Ongoing': [{ id: 'at-2' }],
    });
    const refItemsMap = new Map([
      ['hs-1', refItem('hs-1', { Service: 'Domestic assistance' })],
      ['at-2', refItem('at-2', { Service: 'Walker', 'Service ID / Item ID': 'AT_WALK_03 / IT_AT_014' })],
    ]);

    expect(lookupServiceIdFromRefs(
      servicePlanItem, refItemsMap, SERVICE_REF_ATTRS, getValue, getValueMulti, extractRefId, ID_ATTRS,
    )).toBe('AT_WALK_03');
  });

  it('honours the reference-attribute order, not the item data order', () => {
    const servicePlanItem = refItem('sp-1', {
      'Health Professional': [{ id: 'hp-3' }],
      'Home Support (HS)': [{ id: 'hs-1' }],
    });
    const refItemsMap = new Map([
      ['hs-1', refItem('hs-1', { Service: 'Domestic assistance', 'Service ID/Item ID': 'HS_DOM_01' })],
      ['hp-3', refItem('hp-3', { Service: 'Physio', 'Service ID/Item ID': 'HP_PHYS_02' })],
    ]);

    // 'Home Support (HS)' comes first in SERVICE_REF_ATTRS, so it wins.
    expect(lookupServiceIdFromRefs(
      servicePlanItem, refItemsMap, SERVICE_REF_ATTRS, getValue, getValueMulti, extractRefId, ID_ATTRS,
    )).toBe('HS_DOM_01');
  });

  it('honours the id-attribute order when an item carries several spellings', () => {
    const servicePlanItem = refItem('sp-1', { 'Home Support (HS)': [{ id: 'hs-1' }] });
    const refItemsMap = new Map([
      ['hs-1', refItem('hs-1', {
        Service: 'Domestic assistance',
        'Service ID/Item ID': 'THIRD',
        'Service ID /  Item ID': 'SECOND',
        'Service ID / Item ID': 'FIRST',
      })],
    ]);

    expect(lookupServiceIdFromRefs(
      servicePlanItem, refItemsMap, SERVICE_REF_ATTRS, getValue, getValueMulti, extractRefId, ID_ATTRS,
    )).toBe('FIRST');
  });

  it('returns null when no reference attribute resolves', () => {
    const servicePlanItem = refItem('sp-1', { 'Participant Profile': [{ id: 'pp-1' }] });

    expect(lookupServiceIdFromRefs(
      servicePlanItem, new Map(), SERVICE_REF_ATTRS, getValue, getValueMulti, extractRefId, ID_ATTRS,
    )).toBeNull();
  });

  it('returns null when the reference attribute list is empty', () => {
    const servicePlanItem = refItem('sp-1', { 'Home Support (HS)': [{ id: 'hs-1' }] });
    const refItemsMap = new Map([['hs-1', refItem('hs-1', { 'Service ID/Item ID': 'HS_DOM_01' })]]);

    expect(lookupServiceIdFromRefs(
      servicePlanItem, refItemsMap, [], getValue, getValueMulti, extractRefId, ID_ATTRS,
    )).toBeNull();
  });

  it('returns null when the reference value is an empty array', () => {
    const servicePlanItem = refItem('sp-1', { 'Home Support (HS)': [] });

    expect(lookupServiceIdFromRefs(
      servicePlanItem, new Map(), SERVICE_REF_ATTRS, getValue, getValueMulti, extractRefId, ID_ATTRS,
    )).toBeNull();
  });
});

describe('normalizeHealthProfessionalTypeOther', () => {
  it('drops the " - Other" suffix', () => {
    expect(normalizeHealthProfessionalTypeOther('Physiotherapist - Other')).toBe('Physiotherapist');
  });

  it('keeps only the part before " - Other" when more text follows', () => {
    expect(normalizeHealthProfessionalTypeOther('Occupational Therapist - Other - notes')).toBe('Occupational Therapist');
  });

  it('splits on the whole " - Other" marker, not on the first " - "', () => {
    expect(normalizeHealthProfessionalTypeOther('Speech Pathologist - Adult - Other')).toBe('Speech Pathologist - Adult');
  });

  it('leaves a type without the suffix untouched', () => {
    expect(normalizeHealthProfessionalTypeOther('Physiotherapist')).toBe('Physiotherapist');
  });

  it('does not strip a bare "Other" or a differently spaced variant', () => {
    expect(normalizeHealthProfessionalTypeOther('Other')).toBe('Other');
    expect(normalizeHealthProfessionalTypeOther('Physiotherapist-Other')).toBe('Physiotherapist-Other');
  });

  it('returns falsy inputs unchanged rather than coercing them', () => {
    expect(normalizeHealthProfessionalTypeOther('')).toBe('');
    expect(normalizeHealthProfessionalTypeOther(null)).toBeNull();
    expect(normalizeHealthProfessionalTypeOther(undefined)).toBeUndefined();
  });

  it('returns a non-string truthy value unchanged when it has no suffix', () => {
    expect(normalizeHealthProfessionalTypeOther(42)).toBe(42);
  });
});

describe('lookupHealthProfessionalFromRef', () => {
  const TYPE_CODE_ATTRS = ['Health Professional Type Code'];
  const TYPE_OTHER_ATTRS = ['Health Professional Type'];

  it('returns the type code and normalized type from the referenced item', () => {
    const refItemsMap = new Map([
      ['hp-3', refItem('hp-3', {
        Service: 'Physiotherapy assessment',
        'Health Professional Type Code': 'PT',
        'Health Professional Type': 'Physiotherapist - Other',
      })],
    ]);

    expect(lookupHealthProfessionalFromRef(refItemsMap, 'hp-3', getValueMulti, TYPE_CODE_ATTRS, TYPE_OTHER_ATTRS))
      .toEqual({ typeCode: 'PT', typeOther: 'Physiotherapist' });
  });

  it('returns null when the referenced item is not in the map', () => {
    expect(lookupHealthProfessionalFromRef(new Map(), 'hp-missing', getValueMulti, TYPE_CODE_ATTRS, TYPE_OTHER_ATTRS))
      .toBeNull();
  });

  it('falls back to empty strings for missing type fields', () => {
    const refItemsMap = new Map([
      ['hp-3', refItem('hp-3', { Service: 'Physiotherapy assessment' })],
    ]);

    expect(lookupHealthProfessionalFromRef(refItemsMap, 'hp-3', getValueMulti, TYPE_CODE_ATTRS, TYPE_OTHER_ATTRS))
      .toEqual({ typeCode: '', typeOther: '' });
  });

  it('returns a type code with no type other, and vice versa', () => {
    const codeOnly = new Map([
      ['hp-3', refItem('hp-3', { Service: 'Physio', 'Health Professional Type Code': 'PT' })],
    ]);
    expect(lookupHealthProfessionalFromRef(codeOnly, 'hp-3', getValueMulti, TYPE_CODE_ATTRS, TYPE_OTHER_ATTRS))
      .toEqual({ typeCode: 'PT', typeOther: '' });

    const otherOnly = new Map([
      ['hp-4', refItem('hp-4', { Service: 'Dietetics', 'Health Professional Type': 'Dietitian - Other' })],
    ]);
    expect(lookupHealthProfessionalFromRef(otherOnly, 'hp-4', getValueMulti, TYPE_CODE_ATTRS, TYPE_OTHER_ATTRS))
      .toEqual({ typeCode: '', typeOther: 'Dietitian' });
  });

  it('honours the attribute-name fallback order', () => {
    const refItemsMap = new Map([
      ['hp-3', refItem('hp-3', {
        Service: 'Physio',
        'HP Type Code': 'PRIMARY',
        'Health Professional Type Code': 'FALLBACK',
      })],
    ]);

    expect(lookupHealthProfessionalFromRef(
      refItemsMap, 'hp-3', getValueMulti, ['HP Type Code', 'Health Professional Type Code'], TYPE_OTHER_ATTRS,
    )).toEqual({ typeCode: 'PRIMARY', typeOther: '' });
  });
});
