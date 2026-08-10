import { describe, it, expect, vi } from 'vitest';
import { ITEM_DELETED } from '../../../src/services/isoplus.js';
import { NDIS_SERVICEPLAN_ATTR } from '../../../src/utils/ndisServiceRecords.js';
import {
  LEGACY_SERVICE_AREA_MAP,
  buildLegacyPricingCatalog,
  resolveLegacyServiceAreaReference,
  resolveLegacyPricingCatalogReference,
  resolveLegacyLabourTravelReference,
  fetchLegacyNdisReferencedItems,
  createLegacyQuoteReferenceHandlers,
  fetchLegacyNdisQuoteReferencedItems,
  loadReferencedItemValuesWithWarn,
  createLegacyParticipantsPlanReferenceHandlers,
  fetchLegacyNdisParticipantsPlanReferencedItems,
  resolveServiceAreaReference,
  resolveCatalogReference,
  processNdisQuotePricingReference,
} from '../../../src/utils/ndisPricingReferenceHelpers.js';

const WS = '55369';
const BOARD = 'eNiJpH14PN3';

// Mirrors the ISO+ POST /items/values row shape: every value carries its own id
// and the full attribute descriptor, not just the name the helpers read.
let valueSeq = 0;
const value = (name, data, type = 'text') => ({
  id: `value-${++valueSeq}`,
  attribute: { id: `attr-${name}`, name, type },
  data,
});

// A real NDIS support-catalogue row: 01_011_0107_1_1, weekday daytime self-care.
const supportCatalogueValues = () => [
  value('Support Item Number', '01_011_0107_1_1'),
  value('Support Item Name', 'Assistance With Self-Care Activities - Standard - Weekday Daytime'),
  value('Unit', 'H'),
  value('ACT($)', 67.56, 'number'),
  value('NSW($)', 67.56, 'number'),
  value('NT($)', 67.56, 'number'),
  value('QLD($)', 67.56, 'number'),
  value('SA($)', 67.56, 'number'),
  value('TAS($)', 67.56, 'number'),
  value('VIC($)', 67.56, 'number'),
  value('WA($)', 67.56, 'number'),
  value('Remote($)', 94.58, 'number'),
  value('Very Remote($)', 101.34, 'number'),
  value('Registration Group Number', '0107', 'text'),
];

const supportCatalogueCatalog = (id) => ({
  id,
  itemName: 'Assistance With Self-Care Activities - Standard - Weekday Daytime',
  itemNumber: '01_011_0107_1_1',
  unit: 'H',
  'ACT($)': '67.56',
  'NSW($)': '67.56',
  'NT($)': '67.56',
  'QLD($)': '67.56',
  'SA($)': '67.56',
  'TAS($)': '67.56',
  'VIC($)': '67.56',
  'WA($)': '67.56',
  'Remote($)': '94.58',
  'Very Remote($)': '101.34',
});

const ref = (attributeId, toItemId) => ({
  id: `reference-${attributeId}`,
  attribute_id: attributeId,
  from_item_id: 'quote-17',
  to_item_id: toItemId,
});

/** getItemValues stand-in: the ISO+ HTTP call the helpers take as a dependency. */
const itemValuesFrom = (table) => vi.fn(async (_ws, _board, itemId) => table[itemId]);

describe('buildLegacyPricingCatalog', () => {
  it('reads the item number, name, unit and all ten state columns as strings', () => {
    expect(buildLegacyPricingCatalog(supportCatalogueValues(), 'catalog-1'))
      .toEqual(supportCatalogueCatalog('catalog-1'));
  });

  it('throws when the Support Item Number is missing or blank', () => {
    expect(() => buildLegacyPricingCatalog([value('Unit', 'H')], 'x'))
      .toThrow('Support Item Number is required');
    expect(() => buildLegacyPricingCatalog([value('Support Item Number', '')], 'x'))
      .toThrow('Support Item Number is required');
    expect(() => buildLegacyPricingCatalog([value('Support Item Number', null)], 'x'))
      .toThrow('Support Item Number is required');
    expect(() => buildLegacyPricingCatalog([value('Support Item Number', [])], 'x'))
      .toThrow('Support Item Number is required');
  });

  it('fills absent state columns with an empty string rather than undefined', () => {
    const catalog = buildLegacyPricingCatalog([value('Support Item Number', '01_011_0107_1_1')], 'catalog-2');
    expect(catalog).toEqual({
      id: 'catalog-2',
      itemName: '',
      itemNumber: '01_011_0107_1_1',
      unit: '',
      'ACT($)': '',
      'NSW($)': '',
      'NT($)': '',
      'QLD($)': '',
      'SA($)': '',
      'TAS($)': '',
      'VIC($)': '',
      'WA($)': '',
      'Remote($)': '',
      'Very Remote($)': '',
    });
  });

  it('keeps a zero price as the string "0", not as an empty column', () => {
    const catalog = buildLegacyPricingCatalog([
      value('Support Item Number', '01_011_0107_1_1'),
      value('NSW($)', 0, 'number'),
    ], 'catalog-3');
    expect(catalog['NSW($)']).toBe('0');
  });

  it('stringifies a negative price unchanged', () => {
    const catalog = buildLegacyPricingCatalog([
      value('Support Item Number', '01_011_0107_1_1'),
      value('VIC($)', -12.5, 'number'),
    ], 'catalog-4');
    expect(catalog['VIC($)']).toBe('-12.5');
  });

  it('uses the first match when a column appears twice', () => {
    const catalog = buildLegacyPricingCatalog([
      value('Support Item Number', '01_011_0107_1_1'),
      value('NSW($)', 67.56, 'number'),
      value('NSW($)', 99.99, 'number'),
    ], 'catalog-5');
    expect(catalog['NSW($)']).toBe('67.56');
  });

  it('merges extra fields in, letting them win over the computed ones', () => {
    const catalog = buildLegacyPricingCatalog(supportCatalogueValues(), 'catalog-6', {
      shortNoticeCancellations: 'Y',
      id: 'overridden',
    });
    expect(catalog.shortNoticeCancellations).toBe('Y');
    expect(catalog.id).toBe('overridden');
    expect(catalog['Remote($)']).toBe('94.58');
  });
});

describe('resolveLegacyServiceAreaReference', () => {
  const serviceAreaItem = (area) => ({
    id: 'service-area-1',
    values: [value('Service Area', area), value('Definition', 'Where the support is delivered')],
  });

  it.each([
    ['Non-Remote (ACT)', 'ACT($)'],
    ['Non-Remote (NSW)', 'NSW($)'],
    ['Non-Remote (NT)', 'NT($)'],
    ['Non-Remote (QLD)', 'QLD($)'],
    ['Non-Remote (SA)', 'SA($)'],
    ['Non-Remote (TAS)', 'TAS($)'],
    ['Non-Remote (VIC)', 'VIC($)'],
    ['Non-Remote (WA)', 'WA($)'],
    ['Remote', 'Remote($)'],
    ['Very Remote', 'Very Remote($)'],
  ])('maps %s to the %s price column', async (area, column) => {
    const getItemValues = itemValuesFrom({ 'service-area-1': serviceAreaItem(area) });
    await expect(resolveLegacyServiceAreaReference(WS, BOARD, ref('a', 'service-area-1'), getItemValues))
      .resolves.toEqual({ serviceArea: area, serviceAreaType: column });
    expect(getItemValues).toHaveBeenCalledWith(WS, BOARD, 'service-area-1');
  });

  it('falls back to the ACT column for an unrecognised service area', async () => {
    const getItemValues = itemValuesFrom({ 'service-area-1': serviceAreaItem('Non-Remote (XYZ)') });
    await expect(resolveLegacyServiceAreaReference(WS, BOARD, ref('a', 'service-area-1'), getItemValues))
      .resolves.toEqual({ serviceArea: 'Non-Remote (XYZ)', serviceAreaType: 'ACT($)' });
  });

  it('throws when the Service Area is blank, so the empty-string map entry is unreachable', async () => {
    expect(LEGACY_SERVICE_AREA_MAP['']).toBe('ACT($)');
    const getItemValues = itemValuesFrom({ 'service-area-1': serviceAreaItem('') });
    await expect(resolveLegacyServiceAreaReference(WS, BOARD, ref('a', 'service-area-1'), getItemValues))
      .rejects.toThrow('Service Area is required');
  });

  it('throws when the Service Area attribute is absent entirely', async () => {
    const getItemValues = itemValuesFrom({ 'service-area-1': { id: 'service-area-1', values: [value('Definition', 'x')] } });
    await expect(resolveLegacyServiceAreaReference(WS, BOARD, ref('a', 'service-area-1'), getItemValues))
      .rejects.toThrow('Service Area is required');
  });

  it('throws when values is not an array, because it is treated as empty', async () => {
    const getItemValues = itemValuesFrom({ 'service-area-1': { id: 'service-area-1', values: { 'Service Area': 'Remote' } } });
    await expect(resolveLegacyServiceAreaReference(WS, BOARD, ref('a', 'service-area-1'), getItemValues))
      .rejects.toThrow('Service Area is required');
  });

  it('returns null when the referenced item was deleted or could not be loaded', async () => {
    await expect(resolveLegacyServiceAreaReference(WS, BOARD, ref('a', 'gone'), async () => ITEM_DELETED)).resolves.toBe(null);
    await expect(resolveLegacyServiceAreaReference(WS, BOARD, ref('a', 'gone'), async () => null)).resolves.toBe(null);
    await expect(resolveLegacyServiceAreaReference(WS, BOARD, ref('a', 'gone'), async () => undefined)).resolves.toBe(null);
  });
});

describe('resolveLegacyPricingCatalogReference', () => {
  it('builds the catalog from the referenced catalogue row', async () => {
    const getItemValues = itemValuesFrom({
      'catalog-item-1': { id: 'catalog-item-1', values: supportCatalogueValues() },
    });
    await expect(resolveLegacyPricingCatalogReference(WS, BOARD, ref('a', 'catalog-item-1'), getItemValues))
      .resolves.toEqual(supportCatalogueCatalog('catalog-item-1'));
  });

  it('passes extra fields through to the catalog', async () => {
    const getItemValues = itemValuesFrom({
      'catalog-item-1': { id: 'catalog-item-1', values: supportCatalogueValues() },
    });
    const catalog = await resolveLegacyPricingCatalogReference(
      WS, BOARD, ref('a', 'catalog-item-1'), getItemValues, { source: 'Provider Travel' },
    );
    expect(catalog.source).toBe('Provider Travel');
    expect(catalog.itemNumber).toBe('01_011_0107_1_1');
  });

  it('returns null for a deleted or unloadable reference', async () => {
    await expect(resolveLegacyPricingCatalogReference(WS, BOARD, ref('a', 'gone'), async () => ITEM_DELETED)).resolves.toBe(null);
    await expect(resolveLegacyPricingCatalogReference(WS, BOARD, ref('a', 'gone'), async () => null)).resolves.toBe(null);
  });

  it('throws when the referenced row has no Support Item Number', async () => {
    const getItemValues = itemValuesFrom({ 'catalog-item-1': { id: 'catalog-item-1', values: [value('Unit', 'H')] } });
    await expect(resolveLegacyPricingCatalogReference(WS, BOARD, ref('a', 'catalog-item-1'), getItemValues))
      .rejects.toThrow('Support Item Number is required');
  });

  it('treats a row whose values are missing or not an array as an empty row and throws', async () => {
    const getItemValues = itemValuesFrom({
      'no-values': { id: 'no-values' },
      'bad-values': { id: 'bad-values', values: { 0: value('Support Item Number', '01_011_0107_1_1') } },
    });
    await expect(resolveLegacyPricingCatalogReference(WS, BOARD, ref('a', 'no-values'), getItemValues))
      .rejects.toThrow('Support Item Number is required');
    await expect(resolveLegacyPricingCatalogReference(WS, BOARD, ref('a', 'bad-values'), getItemValues))
      .rejects.toThrow('Support Item Number is required');
  });
});

describe('resolveLegacyLabourTravelReference', () => {
  it('returns the id and the labour travel time cost name', async () => {
    const getItemValues = itemValuesFrom({
      'labour-1': {
        id: 'labour-1',
        values: [
          value('Labour Travel Time Costs', 'Up to 30 minutes each way'),
          value('Unit', 'H'),
        ],
      },
    });
    await expect(resolveLegacyLabourTravelReference(WS, BOARD, ref('a', 'labour-1'), getItemValues))
      .resolves.toEqual({ id: 'labour-1', itemName: 'Up to 30 minutes each way' });
  });

  it('throws when the Labour Travel Time Costs value is missing', async () => {
    const getItemValues = itemValuesFrom({ 'labour-1': { id: 'labour-1', values: [value('Unit', 'H')] } });
    await expect(resolveLegacyLabourTravelReference(WS, BOARD, ref('a', 'labour-1'), getItemValues))
      .rejects.toThrow('Labour Travel Time Costs is required');
  });

  it('returns null for a deleted or unloadable reference', async () => {
    await expect(resolveLegacyLabourTravelReference(WS, BOARD, ref('a', 'gone'), async () => ITEM_DELETED)).resolves.toBe(null);
    await expect(resolveLegacyLabourTravelReference(WS, BOARD, ref('a', 'gone'), async () => null)).resolves.toBe(null);
  });

  it('throws rather than returning null when the row carries no values array', async () => {
    const getItemValues = itemValuesFrom({ 'labour-1': { id: 'labour-1' } });
    await expect(resolveLegacyLabourTravelReference(WS, BOARD, ref('a', 'labour-1'), getItemValues))
      .rejects.toThrow('Labour Travel Time Costs is required');
  });
});

describe('fetchLegacyNdisReferencedItems', () => {
  const emptyResult = { first: null, second: null };

  function deps(overrides = {}) {
    return {
      workspaceId: WS,
      boardId: BOARD,
      itemId: 'quote-17',
      getReferences: vi.fn(async () => ({ data: [] })),
      getAttribute: vi.fn(async () => null),
      getItemValues: vi.fn(async () => null),
      handlerMap: {},
      emptyResult,
      ...overrides,
    };
  }

  it('returns the empty result in declaration order when getReferences answers nothing', async () => {
    await expect(fetchLegacyNdisReferencedItems(deps({ getReferences: vi.fn(async () => null) })))
      .resolves.toEqual([null, null]);
  });

  it('collects handler results into the declared slots', async () => {
    const result = await fetchLegacyNdisReferencedItems(deps({
      getReferences: vi.fn(async () => ({ data: [ref('attr-2', 'item-2'), ref('attr-1', 'item-1')] })),
      getAttribute: vi.fn(async (_ws, _b, attributeId) => ({ name: attributeId === 'attr-1' ? 'One' : 'Two' })),
      handlerMap: {
        One: { resultKey: 'first', handler: async () => 'value-one' },
        Two: { resultKey: 'second', handler: async () => 'value-two' },
      },
    }));
    expect(result).toEqual(['value-one', 'value-two']);
  });

  it('passes the workspace, board, reference and loader through to the handler', async () => {
    const handler = vi.fn(async () => 'ok');
    const getItemValues = vi.fn();
    const reference = ref('attr-1', 'item-1');
    await fetchLegacyNdisReferencedItems(deps({
      getReferences: vi.fn(async () => ({ data: [reference] })),
      getAttribute: vi.fn(async () => ({ name: 'One' })),
      getItemValues,
      handlerMap: { One: { resultKey: 'first', handler } },
    }));
    expect(handler).toHaveBeenCalledWith(WS, BOARD, reference, getItemValues);
  });

  it('skips references whose attribute cannot be loaded', async () => {
    const handler = vi.fn();
    await expect(fetchLegacyNdisReferencedItems(deps({
      getReferences: vi.fn(async () => ({ data: [ref('attr-1', 'item-1')] })),
      getAttribute: vi.fn(async () => null),
      handlerMap: { One: { resultKey: 'first', handler } },
    }))).resolves.toEqual([null, null]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('skips attributes with no handler configured', async () => {
    await expect(fetchLegacyNdisReferencedItems(deps({
      getReferences: vi.fn(async () => ({ data: [ref('attr-9', 'item-9')] })),
      getAttribute: vi.fn(async () => ({ name: 'Generated PDF Link' })),
      handlerMap: { One: { resultKey: 'first', handler: async () => 'x' } },
    }))).resolves.toEqual([null, null]);
  });

  it('leaves the slot at its default when a handler returns null or undefined', async () => {
    await expect(fetchLegacyNdisReferencedItems(deps({
      getReferences: vi.fn(async () => ({ data: [ref('attr-1', 'a'), ref('attr-2', 'b')] })),
      getAttribute: vi.fn(async (_ws, _b, id) => ({ name: id === 'attr-1' ? 'One' : 'Two' })),
      handlerMap: {
        One: { resultKey: 'first', handler: async () => null },
        Two: { resultKey: 'second', handler: async () => undefined },
      },
    }))).resolves.toEqual([null, null]);
  });

  it('lets the last reference win when two point at the same slot', async () => {
    await expect(fetchLegacyNdisReferencedItems(deps({
      getReferences: vi.fn(async () => ({ data: [ref('attr-1', 'a'), ref('attr-1', 'b')] })),
      getAttribute: vi.fn(async () => ({ name: 'One' })),
      handlerMap: { One: { resultKey: 'first', handler: async (_w, _b, reference) => reference.to_item_id } },
    }))).resolves.toEqual(['b', null]);
  });

  it('treats a reference response without a data array as no references', async () => {
    await expect(fetchLegacyNdisReferencedItems(deps({ getReferences: vi.fn(async () => ({})) })))
      .resolves.toEqual([null, null]);
  });
});

describe('createLegacyQuoteReferenceHandlers / fetchLegacyNdisQuoteReferencedItems', () => {
  const table = {
    'service-area-1': { id: 'service-area-1', values: [value('Service Area', 'Remote')] },
    'direct-support-1': { id: 'direct-support-1', values: supportCatalogueValues() },
    'provider-travel-1': {
      id: 'provider-travel-1',
      values: [
        value('Support Item Number', '01_799_0107_1_1'),
        value('Support Item Name', 'Provider Travel - Non Labour Costs'),
        value('Unit', 'E'),
        value('Remote($)', 1.0, 'number'),
      ],
    },
    'activity-transport-1': {
      id: 'activity-transport-1',
      values: [
        value('Support Item Number', '02_051_0108_1_1'),
        value('Support Item Name', 'Activity Based Transport'),
        value('Unit', 'E'),
        value('Remote($)', 0.99, 'number'),
      ],
    },
    'centre-capital-1': {
      id: 'centre-capital-1',
      values: [
        value('Support Item Number', '01_720_0136_6_1'),
        value('Support Item Name', 'Centre Capital Cost'),
        value('Unit', 'H'),
        value('Remote($)', 2.36, 'number'),
      ],
    },
    'labour-travel-1': { id: 'labour-travel-1', values: [value('Labour Travel Time Costs', 'Up to 30 minutes each way')] },
  };

  const attributeByRefId = {
    'ref-service-area': 'Service Area',
    'ref-direct-support': 'Direct Support Item Number',
    'ref-provider-travel': 'Provider Travel - Non-Labour Cost Item Number',
    'ref-activity-transport': 'Activity Based Transport Item Number',
    'ref-centre-capital': 'Centre Capital Costs Item',
    'ref-labour-travel': 'Provider Travel - Labour Travel Time Costs',
  };

  it('exposes a handler per legacy quote reference column', async () => {
    const handlers = createLegacyQuoteReferenceHandlers();
    const getItemValues = itemValuesFrom(table);

    await expect(handlers['Service Area'].handler(WS, BOARD, ref('a', 'service-area-1'), getItemValues))
      .resolves.toEqual({ serviceArea: 'Remote', serviceAreaType: 'Remote($)' });
    await expect(handlers['Direct Support Item Number'].handler(WS, BOARD, ref('a', 'direct-support-1'), getItemValues))
      .resolves.toEqual(supportCatalogueCatalog('direct-support-1'));
    await expect(handlers['Provider Travel - Labour Travel Time Costs'].handler(WS, BOARD, ref('a', 'labour-travel-1'), getItemValues))
      .resolves.toEqual({ id: 'labour-travel-1', itemName: 'Up to 30 minutes each way' });
  });

  it('returns the six quote buckets in order', async () => {
    const result = await fetchLegacyNdisQuoteReferencedItems({
      workspaceId: WS,
      boardId: BOARD,
      itemId: 'quote-17',
      getReferences: async () => ({
        data: [
          ref('ref-labour-travel', 'labour-travel-1'),
          ref('ref-centre-capital', 'centre-capital-1'),
          ref('ref-activity-transport', 'activity-transport-1'),
          ref('ref-provider-travel', 'provider-travel-1'),
          ref('ref-direct-support', 'direct-support-1'),
          ref('ref-service-area', 'service-area-1'),
        ],
      }),
      getAttribute: async (_ws, _b, attributeId) => ({ id: attributeId, name: attributeByRefId[attributeId] }),
      getItemValues: itemValuesFrom(table),
    });

    expect(result).toHaveLength(6);
    expect(result[0]).toEqual({ serviceArea: 'Remote', serviceAreaType: 'Remote($)' });
    expect(result[1]).toEqual(supportCatalogueCatalog('direct-support-1'));
    expect(result[2].itemNumber).toBe('01_799_0107_1_1');
    expect(result[3].itemNumber).toBe('02_051_0108_1_1');
    expect(result[4].itemNumber).toBe('01_720_0136_6_1');
    expect(result[5]).toEqual({ id: 'labour-travel-1', itemName: 'Up to 30 minutes each way' });
  });

  it('leaves buckets null when only some references exist', async () => {
    const result = await fetchLegacyNdisQuoteReferencedItems({
      workspaceId: WS,
      boardId: BOARD,
      itemId: 'quote-17',
      getReferences: async () => ({ data: [ref('ref-service-area', 'service-area-1')] }),
      getAttribute: async (_ws, _b, attributeId) => ({ name: attributeByRefId[attributeId] }),
      getItemValues: itemValuesFrom(table),
    });
    expect(result).toEqual([{ serviceArea: 'Remote', serviceAreaType: 'Remote($)' }, null, null, null, null, null]);
  });

  it('returns six nulls when getReferences answers nothing', async () => {
    const result = await fetchLegacyNdisQuoteReferencedItems({
      workspaceId: WS,
      boardId: BOARD,
      itemId: 'quote-17',
      getReferences: async () => null,
      getAttribute: async () => null,
      getItemValues: async () => null,
    });
    expect(result).toEqual([null, null, null, null, null, null]);
  });
});

describe('loadReferencedItemValuesWithWarn', () => {
  const ctx = { workspaceId: WS, boardId: BOARD, itemId: 'plan-1' };

  it('returns the referenced item and warns about nothing', async () => {
    const warn = vi.fn();
    const referenced = { id: 'ref-1', values: [value('First Name', 'Jordan')] };
    await expect(loadReferencedItemValuesWithWarn(WS, BOARD, 'ref-1', 'Participant Intake Form', async () => referenced, warn, ctx))
      .resolves.toBe(referenced);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns that the item was deleted in ISO+ and returns null', async () => {
    const warn = vi.fn();
    await expect(loadReferencedItemValuesWithWarn(WS, BOARD, 'ref-1', 'Service Area', async () => ITEM_DELETED, warn, ctx))
      .resolves.toBe(null);
    expect(warn).toHaveBeenCalledWith('ISO+™ Service', 'Referenced item deleted in ISO+', {
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1', referenceName: 'Service Area', referencedItemId: 'ref-1',
    });
  });

  it('warns that the item could not be loaded and returns null', async () => {
    const warn = vi.fn();
    await expect(loadReferencedItemValuesWithWarn(WS, BOARD, 'ref-1', 'Service Area', async () => null, warn, ctx))
      .resolves.toBe(null);
    expect(warn).toHaveBeenCalledWith('ISO+™ Service', 'Referenced item not found or failed to load', {
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1', referenceName: 'Service Area', referencedItemId: 'ref-1',
    });
  });

  it('warns with the offending type when values is not an array', async () => {
    const warn = vi.fn();
    await expect(loadReferencedItemValuesWithWarn(WS, BOARD, 'ref-1', 'Service Area', async () => ({ id: 'ref-1', values: 'oops' }), warn, ctx))
      .resolves.toBe(null);
    expect(warn).toHaveBeenCalledWith('ISO+™ Service', 'Referenced item values missing/invalid', {
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1', referenceName: 'Service Area', referencedItemId: 'ref-1',
      valuesType: 'string',
    });
  });

  it('rejects a missing values array as invalid rather than defaulting it to empty', async () => {
    const warn = vi.fn();
    await expect(loadReferencedItemValuesWithWarn(WS, BOARD, 'ref-1', 'Service Area', async () => ({ id: 'ref-1' }), warn, ctx))
      .resolves.toBe(null);
    expect(warn.mock.calls[0][2].valuesType).toBe('undefined');
  });
});

describe('createLegacyParticipantsPlanReferenceHandlers', () => {
  const ctx = { workspaceId: WS, boardId: BOARD, itemId: 'plan-1' };

  it('builds a participants-plan catalog with the four policy flags defaulted to NA', async () => {
    const warn = vi.fn();
    const handlers = createLegacyParticipantsPlanReferenceHandlers(warn, ctx);
    const getItemValues = itemValuesFrom({ 'catalog-1': { id: 'catalog-1', values: supportCatalogueValues() } });

    await expect(handlers['Direct Support Item Number'].handler(WS, BOARD, ref('a', 'catalog-1'), getItemValues))
      .resolves.toEqual({
        ...supportCatalogueCatalog('catalog-1'),
        providerTravel: 'NA',
        ndiaRequestedReports: 'NA',
        nonFaceToFaceSupportProvision: 'NA',
        shortNoticeCancellations: 'NA',
      });
  });

  it('carries the four policy flags through when the catalogue row sets them', async () => {
    const handlers = createLegacyParticipantsPlanReferenceHandlers(vi.fn(), ctx);
    const getItemValues = itemValuesFrom({
      'catalog-1': {
        id: 'catalog-1',
        values: [
          ...supportCatalogueValues(),
          value('Provider Travel', 'Y'),
          value('NDIA Requested Reports', 'N'),
          value('Non-Face-to-Face Support Provision', 'Y'),
          value('Short Notice Cancellations', 'Y'),
        ],
      },
    });
    const catalog = await handlers['Centre Capital Costs Item'].handler(WS, BOARD, ref('a', 'catalog-1'), getItemValues);
    expect(catalog.providerTravel).toBe('Y');
    expect(catalog.ndiaRequestedReports).toBe('N');
    expect(catalog.nonFaceToFaceSupportProvision).toBe('Y');
    expect(catalog.shortNoticeCancellations).toBe('Y');
  });

  it('returns null and warns when a catalogue reference is deleted', async () => {
    const warn = vi.fn();
    const handlers = createLegacyParticipantsPlanReferenceHandlers(warn, ctx);
    await expect(handlers['Activity Based Transport Item Number'].handler(WS, BOARD, ref('a', 'gone'), async () => ITEM_DELETED))
      .resolves.toBe(null);
    expect(warn).toHaveBeenCalledWith('ISO+™ Service', 'Referenced item deleted in ISO+', expect.objectContaining({
      referenceName: 'Activity Based Transport Item Number', referencedItemId: 'gone',
    }));
  });

  it('throws when a catalogue reference has no Support Item Number', async () => {
    const handlers = createLegacyParticipantsPlanReferenceHandlers(vi.fn(), ctx);
    const getItemValues = itemValuesFrom({ 'catalog-1': { id: 'catalog-1', values: [value('Unit', 'H')] } });
    await expect(handlers['Provider Travel - Non-Labour Cost Item Number'].handler(WS, BOARD, ref('a', 'catalog-1'), getItemValues))
      .rejects.toThrow('Support Item Number is required');
  });

  it('reads the participant name fields off the intake form', async () => {
    const handlers = createLegacyParticipantsPlanReferenceHandlers(vi.fn(), ctx);
    const getItemValues = itemValuesFrom({
      'intake-1': {
        id: 'intake-1',
        values: [
          value('Full Name/Preferred Name', 'Jordan Fixture'),
          value('First Name', 'Jordan'),
          value('Last Name', 'Fixture'),
          value('Email', 'jordan@example.invalid'),
        ],
      },
    });
    await expect(handlers['Participant Intake Form'].handler(WS, BOARD, ref('a', 'intake-1'), getItemValues))
      .resolves.toEqual({ fullName: 'Jordan Fixture', firstName: 'Jordan', lastName: 'Fixture' });
  });

  it('returns empty strings for missing participant name fields', async () => {
    const handlers = createLegacyParticipantsPlanReferenceHandlers(vi.fn(), ctx);
    const getItemValues = itemValuesFrom({ 'intake-1': { id: 'intake-1', values: [value('Email', 'x@example.invalid')] } });
    await expect(handlers['Participant Intake Form'].handler(WS, BOARD, ref('a', 'intake-1'), getItemValues))
      .resolves.toEqual({ fullName: '', firstName: '', lastName: '' });
  });

  it('returns null and warns when the intake form reference is deleted', async () => {
    const warn = vi.fn();
    const handlers = createLegacyParticipantsPlanReferenceHandlers(warn, ctx);
    await expect(handlers['Participant Intake Form'].handler(WS, BOARD, ref('a', 'gone'), async () => ITEM_DELETED))
      .resolves.toBe(null);
    expect(warn).toHaveBeenCalledWith('ISO+™ Service', 'Referenced item deleted in ISO+', {
      ...ctx, referenceName: 'Participant Intake Form', referencedItemId: 'gone',
    });
  });

  it('returns null and warns when the intake form fails to load', async () => {
    const warn = vi.fn();
    const handlers = createLegacyParticipantsPlanReferenceHandlers(warn, ctx);
    await expect(handlers['Participant Intake Form'].handler(WS, BOARD, ref('a', 'gone'), async () => null))
      .resolves.toBe(null);
    expect(warn).toHaveBeenCalledWith('ISO+™ Service', 'Referenced item not found or failed to load', {
      ...ctx, referenceName: 'Participant Intake Form', referencedItemId: 'gone',
    });
  });

  it('resolves Service Area with the legacy state-column map, not the national one', async () => {
    const handlers = createLegacyParticipantsPlanReferenceHandlers(vi.fn(), ctx);
    const getItemValues = itemValuesFrom({ 'sa-1': { id: 'sa-1', values: [value('Service Area', 'Non-Remote (VIC)')] } });
    await expect(handlers['Service Area'].handler(WS, BOARD, ref('a', 'sa-1'), getItemValues))
      .resolves.toEqual({ serviceArea: 'Non-Remote (VIC)', serviceAreaType: 'VIC($)' });
  });
});

describe('fetchLegacyNdisParticipantsPlanReferencedItems', () => {
  const table = {
    'sa-1': { id: 'sa-1', values: [value('Service Area', 'Non-Remote (NSW)')] },
    'ds-1': { id: 'ds-1', values: supportCatalogueValues() },
    'intake-1': {
      id: 'intake-1',
      values: [value('Full Name/Preferred Name', 'Jordan Fixture'), value('First Name', 'Jordan'), value('Last Name', 'Fixture')],
    },
  };
  const names = {
    'ref-sa': 'Service Area',
    'ref-ds': 'Direct Support Item Number',
    'ref-intake': 'Participant Intake Form',
    'ref-pdf': 'Generated PDF Link',
  };

  it('warns and returns six nulls when the plan item has no references', async () => {
    const warn = vi.fn();
    await expect(fetchLegacyNdisParticipantsPlanReferencedItems({
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1',
      getReferences: async () => ({ data: [] }), getAttribute: async () => null, getItemValues: async () => null, warn,
    })).resolves.toEqual([null, null, null, null, null, null]);
    expect(warn).toHaveBeenCalledWith('ISO+™ Service', 'Missing references for Participants Service Plan item', {
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1',
    });
  });

  it('warns and returns six nulls when getReferences answers nothing', async () => {
    const warn = vi.fn();
    await expect(fetchLegacyNdisParticipantsPlanReferencedItems({
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1',
      getReferences: async () => null, getAttribute: async () => null, getItemValues: async () => null, warn,
    })).resolves.toEqual([null, null, null, null, null, null]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fills the service area, direct support and participant slots and leaves the rest null', async () => {
    const warn = vi.fn();
    const result = await fetchLegacyNdisParticipantsPlanReferencedItems({
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1',
      getReferences: async () => ({
        data: [ref('ref-intake', 'intake-1'), ref('ref-pdf', 'pdf-1'), ref('ref-ds', 'ds-1'), ref('ref-sa', 'sa-1')],
      }),
      getAttribute: async (_ws, _b, attributeId) => (names[attributeId] ? { name: names[attributeId] } : null),
      getItemValues: itemValuesFrom(table),
      warn,
    });

    expect(result[0]).toEqual({ serviceArea: 'Non-Remote (NSW)', serviceAreaType: 'NSW($)' });
    expect(result[1]).toEqual({
      ...supportCatalogueCatalog('ds-1'),
      providerTravel: 'NA',
      ndiaRequestedReports: 'NA',
      nonFaceToFaceSupportProvision: 'NA',
      shortNoticeCancellations: 'NA',
    });
    expect(result[2]).toBe(null);
    expect(result[3]).toBe(null);
    expect(result[4]).toBe(null);
    expect(result[5]).toEqual({ fullName: 'Jordan Fixture', firstName: 'Jordan', lastName: 'Fixture' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a reference whose attribute cannot be loaded', async () => {
    const result = await fetchLegacyNdisParticipantsPlanReferencedItems({
      workspaceId: WS, boardId: BOARD, itemId: 'plan-1',
      getReferences: async () => ({ data: [ref('ref-sa', 'sa-1')] }),
      getAttribute: async () => null,
      getItemValues: itemValuesFrom(table),
      warn: vi.fn(),
    });
    expect(result).toEqual([null, null, null, null, null, null]);
  });
});

describe('resolveServiceAreaReference (new pricing)', () => {
  const NEW_MAP = {
    'Non-Remote (ACT)': 'National($)',
    'Non-Remote (NSW)': 'National($)',
    'Non-Remote (VIC)': 'National($)',
    Remote: 'Remote($)',
    'Very Remote': 'Very Remote($)',
    '': 'National($)',
  };

  it('collapses the non-remote states onto the National column', async () => {
    const getItemValues = itemValuesFrom({ 'sa-1': { id: 'sa-1', values: [value('Service Area', 'Non-Remote (VIC)')] } });
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'sa-1'), getItemValues, NEW_MAP))
      .resolves.toEqual({ serviceArea: 'Non-Remote (VIC)', serviceAreaType: 'National($)' });
  });

  it('keeps Remote and Very Remote on their own columns', async () => {
    const getItemValues = itemValuesFrom({
      'sa-remote': { id: 'sa-remote', values: [value('Service Area', 'Remote')] },
      'sa-very': { id: 'sa-very', values: [value('Service Area', 'Very Remote')] },
    });
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'sa-remote'), getItemValues, NEW_MAP))
      .resolves.toEqual({ serviceArea: 'Remote', serviceAreaType: 'Remote($)' });
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'sa-very'), getItemValues, NEW_MAP))
      .resolves.toEqual({ serviceArea: 'Very Remote', serviceAreaType: 'Very Remote($)' });
  });

  it('falls back to the National column for an unmapped service area', async () => {
    const getItemValues = itemValuesFrom({ 'sa-1': { id: 'sa-1', values: [value('Service Area', 'Non-Remote (XYZ)')] } });
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'sa-1'), getItemValues, NEW_MAP))
      .resolves.toEqual({ serviceArea: 'Non-Remote (XYZ)', serviceAreaType: 'National($)' });
  });

  it('accepts a present-but-empty Service Area, unlike the legacy resolver which throws', async () => {
    const getItemValues = itemValuesFrom({ 'sa-1': { id: 'sa-1', values: [value('Service Area', null)] } });
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'sa-1'), getItemValues, NEW_MAP))
      .resolves.toEqual({ serviceArea: '', serviceAreaType: 'National($)' });
  });

  it('throws when the Service Area attribute is absent', async () => {
    const getItemValues = itemValuesFrom({ 'sa-1': { id: 'sa-1', values: [value('Definition', 'x')] } });
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'sa-1'), getItemValues, NEW_MAP))
      .rejects.toThrow('Service Area is required');
  });

  it('throws when the referenced row carries no values array', async () => {
    const getItemValues = itemValuesFrom({ 'sa-1': { id: 'sa-1' } });
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'sa-1'), getItemValues, NEW_MAP))
      .rejects.toThrow('Service Area is required');
  });

  it('returns null for a deleted or unloadable reference', async () => {
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'gone'), async () => ITEM_DELETED, NEW_MAP)).resolves.toBe(null);
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'gone'), async () => null, NEW_MAP)).resolves.toBe(null);
  });

  it('throws a TypeError on a value row with no attribute, where the legacy resolver would not', async () => {
    const getItemValues = itemValuesFrom({ 'sa-1': { id: 'sa-1', values: [{ id: 'v', data: 'x' }] } });
    await expect(resolveServiceAreaReference(WS, BOARD, ref('a', 'sa-1'), getItemValues, NEW_MAP))
      .rejects.toThrow(TypeError);
  });
});

describe('resolveCatalogReference', () => {
  const build = (values) => ({
    itemName: values.find((v) => v.attribute.name === 'Support Item Name')?.data ?? '',
    itemNumber: values.find((v) => v.attribute.name === 'Support Item Number')?.data ?? '',
  });

  it('prefixes the referenced item id onto the built catalog', async () => {
    const getItemValues = itemValuesFrom({
      'catalog-1': {
        id: 'catalog-1',
        values: [value('Support Item Number', '01_011_0107_1_1'), value('Support Item Name', 'Self-Care Weekday Daytime')],
      },
    });
    await expect(resolveCatalogReference(WS, BOARD, ref('a', 'catalog-1'), getItemValues, build))
      .resolves.toEqual({ id: 'catalog-1', itemNumber: '01_011_0107_1_1', itemName: 'Self-Care Weekday Daytime' });
  });

  it('returns null when the built catalog has no item number', async () => {
    const getItemValues = itemValuesFrom({ 'catalog-1': { id: 'catalog-1', values: [value('Support Item Name', 'Nameless')] } });
    await expect(resolveCatalogReference(WS, BOARD, ref('a', 'catalog-1'), getItemValues, build)).resolves.toBe(null);
  });

  it('hands the builder an empty array when values is missing', async () => {
    const builder = vi.fn(() => ({ itemNumber: '' }));
    const getItemValues = itemValuesFrom({ 'catalog-1': { id: 'catalog-1' } });
    await expect(resolveCatalogReference(WS, BOARD, ref('a', 'catalog-1'), getItemValues, builder)).resolves.toBe(null);
    expect(builder).toHaveBeenCalledWith([]);
  });

  it('returns null for a deleted or unloadable reference without calling the builder', async () => {
    const builder = vi.fn();
    await expect(resolveCatalogReference(WS, BOARD, ref('a', 'gone'), async () => ITEM_DELETED, builder)).resolves.toBe(null);
    await expect(resolveCatalogReference(WS, BOARD, ref('a', 'gone'), async () => null, builder)).resolves.toBe(null);
    expect(builder).not.toHaveBeenCalled();
  });
});

describe('processNdisQuotePricingReference', () => {
  const NEW_MAP = { Remote: 'Remote($)', '': 'National($)' };
  const buildCatalogFromValues = (values) => ({
    itemNumber: values.find((v) => v.attribute.name === 'Support Item Number')?.data ?? '',
  });
  const deps = (table) => ({
    getItemValues: itemValuesFrom(table),
    buildCatalogFromValues,
    newServiceAreaMap: NEW_MAP,
  });

  it('routes Service Area to the service area resolver', async () => {
    const d = deps({ 'sa-1': { id: 'sa-1', values: [value('Service Area', 'Remote')] } });
    await expect(processNdisQuotePricingReference('Service Area', ref('a', 'sa-1'), WS, BOARD, d))
      .resolves.toEqual({ kind: 'serviceArea', value: { serviceArea: 'Remote', serviceAreaType: 'Remote($)' } });
  });

  it('routes the new Support Item Number to the support bucket', async () => {
    const d = deps({ 'sup-1': { id: 'sup-1', values: [value('Support Item Number', '01_011_0107_1_1')] } });
    await expect(processNdisQuotePricingReference(NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT, ref('a', 'sup-1'), WS, BOARD, d))
      .resolves.toEqual({ kind: 'support', value: { id: 'sup-1', itemNumber: '01_011_0107_1_1' } });
  });

  it('routes the non-labour provider travel item to the providerTravel bucket', async () => {
    const d = deps({ 'pt-1': { id: 'pt-1', values: [value('Support Item Number', '01_799_0107_1_1')] } });
    await expect(processNdisQuotePricingReference(
      NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR, ref('a', 'pt-1'), WS, BOARD, d,
    )).resolves.toEqual({ kind: 'providerTravel', value: { id: 'pt-1', itemNumber: '01_799_0107_1_1' } });
  });

  it('reports a null value when the routed reference is deleted', async () => {
    const d = { getItemValues: async () => ITEM_DELETED, buildCatalogFromValues, newServiceAreaMap: NEW_MAP };
    await expect(processNdisQuotePricingReference(NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT, ref('a', 'gone'), WS, BOARD, d))
      .resolves.toEqual({ kind: 'support', value: null });
  });

  it('classifies the legacy Direct Support column as unknown on the new path', async () => {
    const getItemValues = vi.fn();
    await expect(processNdisQuotePricingReference('Direct Support Item Number', ref('a', 'x'), WS, BOARD, {
      getItemValues, buildCatalogFromValues, newServiceAreaMap: NEW_MAP,
    })).resolves.toEqual({ kind: 'unknown', value: null });
    expect(getItemValues).not.toHaveBeenCalled();
  });

  it('classifies an unrelated attribute as unknown', async () => {
    await expect(processNdisQuotePricingReference('Generated PDF Link', ref('a', 'x'), WS, BOARD, {
      getItemValues: vi.fn(), buildCatalogFromValues, newServiceAreaMap: NEW_MAP,
    })).resolves.toEqual({ kind: 'unknown', value: null });
  });
});
