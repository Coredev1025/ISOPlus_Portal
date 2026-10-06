import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildNdisUnitPriceMapping,
  applyServiceAreaQuotePricingUpdates,
  applyServiceAreaParticipantsPlanPricingUpdates,
  processParticipantsServicePlanType,
} from '../../../src/utils/ndisRoutePricingHelpers.js';

// `safeGet` is injected by src/routes/ndis.js; both call sites define it identically.
// Reproduced verbatim so the tests exercise the real reference-array unwrapping.
const safeGet = (obj, key) => (Array.isArray(obj?.[key]) && obj[key].length > 0 ? obj[key][0] : undefined);

// Webhook payload shape: item.values maps attribute name -> array of referenced item ids.
// Mirrors test/fixtures/ndis-quote-board.json -> webhookPayloads[*].items[0].values.
const itemsValues = () => ({
  'Direct Support Item Number': ['ref-direct-support'],
  'Activity Based Transport Item Number': ['ref-activity-transport'],
  'Provider Travel - Non-Labour Cost Item Number': ['ref-provider-travel'],
  'Centre Capital Costs Item': ['ref-centre-capital'],
});

// Catalog shape produced by buildLegacyPricingCatalog() in ndisPricingReferenceHelpers.js:
// every state column is a string, because readAttributeValue() stringifies.
// Prices follow the real NDIS ratios (Remote = 1.4x, Very Remote = 1.5x of the
// non-remote rate) so a wrong-column mutation produces a visibly wrong dollar figure.
const directSupportCatalog = () => ({
  id: 'cat-direct-support',
  itemName: 'Assistance With Self-Care Activities - Standard - Weekday Daytime',
  itemNumber: '01_011_0107_1_1',
  unit: 'Hour',
  'ACT($)': '67.56',
  'NSW($)': '67.56',
  'NT($)': '67.56',
  'QLD($)': '67.56',
  'SA($)': '67.56',
  'TAS($)': '67.56',
  'VIC($)': '62.17',
  'WA($)': '67.56',
  'Remote($)': '94.59',
  'Very Remote($)': '101.34',
});

const activityTransportCatalog = () => ({
  id: 'cat-activity-transport',
  itemName: 'Activity Based Transport',
  itemNumber: '02_051_0108_1_1',
  unit: 'Each',
  'ACT($)': '1.00',
  'NSW($)': '1.00',
  'NT($)': '1.00',
  'QLD($)': '1.00',
  'SA($)': '1.00',
  'TAS($)': '1.00',
  'VIC($)': '1.00',
  'WA($)': '1.00',
  'Remote($)': '1.40',
  'Very Remote($)': '1.50',
});

const providerTravelCatalog = () => ({
  id: 'cat-provider-travel',
  itemName: 'Provider Travel - Non Labour Costs',
  itemNumber: '02_799_0106_6_1',
  unit: 'Each',
  'ACT($)': '0.99',
  'NSW($)': '0.99',
  'NT($)': '0.99',
  'QLD($)': '0.99',
  'SA($)': '0.99',
  'TAS($)': '0.99',
  'VIC($)': '0.99',
  'WA($)': '0.99',
  'Remote($)': '1.39',
  'Very Remote($)': '1.49',
});

const centreCapitalCatalog = () => ({
  id: 'cat-centre-capital',
  itemName: 'Centre Capital Cost',
  itemNumber: '01_720_0115_1_1',
  unit: 'Each',
  'ACT($)': '2.63',
  'NSW($)': '2.63',
  'NT($)': '2.63',
  'QLD($)': '2.63',
  'SA($)': '2.63',
  'TAS($)': '2.63',
  'VIC($)': '2.63',
  'WA($)': '2.63',
  'Remote($)': '3.68',
  'Very Remote($)': '3.95',
});

const NSW = { serviceArea: 'Non-Remote (NSW)', serviceAreaType: 'NSW($)' };
const VERY_REMOTE = { serviceArea: 'Very Remote', serviceAreaType: 'Very Remote($)' };

describe('buildNdisUnitPriceMapping', () => {
  it('selects the price column named by serviceAreaType', () => {
    expect(
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues: itemsValues(),
        serviceAreaValues: NSW,
        pricingValues: directSupportCatalog(),
        itemNumberKey: 'Direct Support Item Number',
        unitAttr: 'Unit (Direct Support)',
        unitPriceAttr: 'Unit Price for Direct Support($)',
      }),
    ).toEqual({
      itemId: 'ref-direct-support',
      serviceArea: 'NSW($)',
      unit: 'Hour',
      unitAttr: 'Unit (Direct Support)',
      unitPrice: '67.56',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
  });

  it('picks a different column for a different service area on the same catalog', () => {
    const mapping = buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: itemsValues(),
      serviceAreaValues: VERY_REMOTE,
      pricingValues: directSupportCatalog(),
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    // Very Remote is 1.5x the $67.56 non-remote rate.
    expect(mapping.unitPrice).toBe('101.34');
    expect(mapping.serviceArea).toBe('Very Remote($)');
  });

  it('emits the state price, not the national one, for a state whose rate differs', () => {
    const mapping = buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: itemsValues(),
      serviceAreaValues: { serviceArea: 'Non-Remote (VIC)', serviceAreaType: 'VIC($)' },
      pricingValues: directSupportCatalog(),
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(mapping.unitPrice).toBe('62.17');
  });

  it('writes serviceArea as the column key, not the human-readable service area name', () => {
    const mapping = buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: itemsValues(),
      serviceAreaValues: NSW,
      pricingValues: directSupportCatalog(),
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(mapping.serviceArea).toBe('NSW($)');
    expect(mapping.serviceArea).not.toBe('Non-Remote (NSW)');
  });

  it('yields unitPrice undefined when the catalog has no column for the service area (rate lookup miss)', () => {
    const catalogWithoutNational = directSupportCatalog();
    const mapping = buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: itemsValues(),
      // New-pricing catalogs carry National($); legacy catalogs do not.
      serviceAreaValues: { serviceArea: '', serviceAreaType: 'National($)' },
      pricingValues: catalogWithoutNational,
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(mapping.unitPrice).toBeUndefined();
    expect(mapping.serviceArea).toBe('National($)');
  });

  it('passes an empty-string price through unchanged rather than defaulting it', () => {
    const catalog = { ...directSupportCatalog(), 'NSW($)': '' };
    const mapping = buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: itemsValues(),
      serviceAreaValues: NSW,
      pricingValues: catalog,
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(mapping.unitPrice).toBe('');
  });

  it('preserves a numeric zero price', () => {
    const catalog = { ...directSupportCatalog(), 'NSW($)': 0 };
    const mapping = buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: itemsValues(),
      serviceAreaValues: NSW,
      pricingValues: catalog,
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(mapping.unitPrice).toBe(0);
  });

  it('preserves a negative price (no clamping)', () => {
    const catalog = { ...directSupportCatalog(), 'NSW($)': '-12.50' };
    const mapping = buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: itemsValues(),
      serviceAreaValues: NSW,
      pricingValues: catalog,
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(mapping.unitPrice).toBe('-12.50');
  });

  it('yields itemId undefined when the payload has no reference for the item-number key', () => {
    const mapping = buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: { 'Direct Support Item Number': [] },
      serviceAreaValues: NSW,
      pricingValues: directSupportCatalog(),
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(mapping.itemId).toBeUndefined();
    // The rest of the mapping is still built.
    expect(mapping.unitPrice).toBe('67.56');
  });

  it('reads the item id through the injected safeGet with exactly (itemsValues, itemNumberKey)', () => {
    const values = itemsValues();
    const spy = vi.fn(() => 'from-safe-get');
    const mapping = buildNdisUnitPriceMapping({
      safeGet: spy,
      itemsValues: values,
      serviceAreaValues: NSW,
      pricingValues: directSupportCatalog(),
      itemNumberKey: 'Centre Capital Costs Item',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(spy.mock.calls).toEqual([[values, 'Centre Capital Costs Item']]);
    expect(mapping.itemId).toBe('from-safe-get');
  });

  it('takes unit from the catalog, not from the payload', () => {
    const mapping = buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: { ...itemsValues(), unit: 'Day' },
      serviceAreaValues: NSW,
      pricingValues: { ...directSupportCatalog(), unit: 'Week' },
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(mapping.unit).toBe('Week');
  });

  it('does not mutate its inputs', () => {
    const values = itemsValues();
    const catalog = directSupportCatalog();
    const area = { ...NSW };
    buildNdisUnitPriceMapping({
      safeGet,
      itemsValues: values,
      serviceAreaValues: area,
      pricingValues: catalog,
      itemNumberKey: 'Direct Support Item Number',
      unitAttr: 'Unit (Direct Support)',
      unitPriceAttr: 'Unit Price for Direct Support($)',
    });
    expect(values).toEqual(itemsValues());
    expect(catalog).toEqual(directSupportCatalog());
    expect(area).toEqual(NSW);
  });

  it('throws when serviceAreaValues is missing (callers must default it first)', () => {
    expect(() =>
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues: itemsValues(),
        serviceAreaValues: null,
        pricingValues: directSupportCatalog(),
        itemNumberKey: 'Direct Support Item Number',
        unitAttr: 'Unit (Direct Support)',
        unitPriceAttr: 'Unit Price for Direct Support($)',
      }),
    ).toThrow(TypeError);
  });

  it('throws when pricingValues is missing', () => {
    expect(() =>
      buildNdisUnitPriceMapping({
        safeGet,
        itemsValues: itemsValues(),
        serviceAreaValues: NSW,
        pricingValues: null,
        itemNumberKey: 'Direct Support Item Number',
        unitAttr: 'Unit (Direct Support)',
        unitPriceAttr: 'Unit Price for Direct Support($)',
      }),
    ).toThrow(TypeError);
  });
});

describe('applyServiceAreaQuotePricingUpdates', () => {
  const baseCtx = (overrides = {}) => ({
    workspaceId: '55369',
    boardId: 'eNiJpH14PN3',
    itemId: 'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
    itemsValues: itemsValues(),
    serviceAreaValues: NSW,
    directSupportValues: null,
    activityBasedTransportValues: null,
    providerTravelValues: null,
    centreCapitalCostsValues: null,
    safeGet,
    handleUpdate: vi.fn(async () => ({ message: 'ok' })),
    ...overrides,
  });

  it('issues all four quote updates, in order, with the quote unit-price attribute names', async () => {
    const handleUpdate = vi.fn(async () => ({ message: 'ok' }));
    await applyServiceAreaQuotePricingUpdates(
      baseCtx({
        handleUpdate,
        directSupportValues: directSupportCatalog(),
        activityBasedTransportValues: activityTransportCatalog(),
        providerTravelValues: providerTravelCatalog(),
        centreCapitalCostsValues: centreCapitalCatalog(),
      }),
    );

    expect(handleUpdate.mock.calls).toEqual([
      [
        '55369',
        'eNiJpH14PN3',
        'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
        {
          itemId: 'ref-direct-support',
          serviceArea: 'NSW($)',
          unit: 'Hour',
          unitAttr: 'Unit (Direct Support)',
          unitPrice: '67.56',
          unitPriceAttr: 'Unit Price for Direct Support($)',
        },
        'direct_support',
        'Direct Support',
      ],
      [
        '55369',
        'eNiJpH14PN3',
        'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
        {
          itemId: 'ref-activity-transport',
          serviceArea: 'NSW($)',
          unit: 'Each',
          unitAttr: 'Unit (Activity Based Transport)',
          unitPrice: '1.00',
          unitPriceAttr: 'Unit Price for Activity Based Transport($)',
        },
        'activity_based_transport',
        'Activity Based Transport',
      ],
      [
        '55369',
        'eNiJpH14PN3',
        'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
        {
          itemId: 'ref-provider-travel',
          serviceArea: 'NSW($)',
          unit: 'Each',
          unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
          unitPrice: '0.99',
          unitPriceAttr: 'Unit Price for Provider Travel($)',
        },
        'provider_travel_non_labour_cost',
        'Provider Travel Non Labour Cost',
      ],
      [
        '55369',
        'eNiJpH14PN3',
        'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
        {
          itemId: 'ref-centre-capital',
          serviceArea: 'NSW($)',
          unit: 'Each',
          unitAttr: 'Unit (Centre Capital Costs)',
          unitPrice: '2.63',
          unitPriceAttr: 'Unit Price for Centre Capital Costs($)',
        },
        'centre_capital_cost',
        'Centre Capital Costs',
      ],
    ]);
  });

  it('passes no webhookType argument, leaving handleUpdate on its set-unit-and-unitprice default', async () => {
    const handleUpdate = vi.fn(async () => ({ message: 'ok' }));
    await applyServiceAreaQuotePricingUpdates(
      baseCtx({ handleUpdate, directSupportValues: directSupportCatalog() }),
    );
    expect(handleUpdate.mock.calls[0]).toHaveLength(6);
  });

  it('skips every catalog that is absent', async () => {
    const handleUpdate = vi.fn(async () => ({ message: 'ok' }));
    await applyServiceAreaQuotePricingUpdates(baseCtx({ handleUpdate }));
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('updates only the catalogs that are present', async () => {
    const handleUpdate = vi.fn(async () => ({ message: 'ok' }));
    await applyServiceAreaQuotePricingUpdates(
      baseCtx({ handleUpdate, providerTravelValues: providerTravelCatalog() }),
    );
    expect(handleUpdate).toHaveBeenCalledTimes(1);
    expect(handleUpdate.mock.calls[0][4]).toBe('provider_travel_non_labour_cost');
  });

  it('treats undefined the same as null and skips the update', async () => {
    const handleUpdate = vi.fn(async () => ({ message: 'ok' }));
    await applyServiceAreaQuotePricingUpdates(
      baseCtx({ handleUpdate, directSupportValues: undefined, centreCapitalCostsValues: centreCapitalCatalog() }),
    );
    expect(handleUpdate).toHaveBeenCalledTimes(1);
    expect(handleUpdate.mock.calls[0][4]).toBe('centre_capital_cost');
  });

  it('awaits each update before starting the next', async () => {
    const order = [];
    const handleUpdate = vi.fn(async (_w, _b, _i, _m, type) => {
      order.push(`enter:${type}`);
      await Promise.resolve();
      order.push(`exit:${type}`);
      return { message: 'ok' };
    });
    await applyServiceAreaQuotePricingUpdates(
      baseCtx({
        handleUpdate,
        directSupportValues: directSupportCatalog(),
        activityBasedTransportValues: activityTransportCatalog(),
      }),
    );
    expect(order).toEqual([
      'enter:direct_support',
      'exit:direct_support',
      'enter:activity_based_transport',
      'exit:activity_based_transport',
    ]);
  });

  it('propagates a rejection and does not attempt the remaining updates', async () => {
    const handleUpdate = vi.fn(async () => {
      throw new Error('ISO+ 502');
    });
    await expect(
      applyServiceAreaQuotePricingUpdates(
        baseCtx({
          handleUpdate,
          directSupportValues: directSupportCatalog(),
          activityBasedTransportValues: activityTransportCatalog(),
        }),
      ),
    ).rejects.toThrow('ISO+ 502');
    expect(handleUpdate).toHaveBeenCalledTimes(1);
  });

  it('carries a rate lookup miss through to handleUpdate rather than skipping the update', async () => {
    const handleUpdate = vi.fn(async () => ({ message: 'ok' }));
    await applyServiceAreaQuotePricingUpdates(
      baseCtx({
        handleUpdate,
        serviceAreaValues: { serviceArea: 'Nowhere', serviceAreaType: 'National($)' },
        directSupportValues: directSupportCatalog(),
      }),
    );
    expect(handleUpdate).toHaveBeenCalledTimes(1);
    expect(handleUpdate.mock.calls[0][3].unitPrice).toBeUndefined();
  });
});

describe('applyServiceAreaParticipantsPlanPricingUpdates', () => {
  const baseCtx = (overrides = {}) => ({
    workspaceId: '55369',
    boardId: 'eNiJpH14PN3',
    itemId: 'fixture-quote-legacy-pricing',
    itemsValues: itemsValues(),
    serviceAreaValues: NSW,
    directSupportValues: null,
    activityBasedTransportValues: null,
    providerTravelValues: null,
    centreCapitalCostsValues: null,
    safeGet,
    handleUpdate: vi.fn(async () => ({ message: 'ok' })),
    ...overrides,
  });

  it('issues all four plan updates with the "Agreed" attribute names and the Participants-Service-Plan webhook type', async () => {
    const handleUpdate = vi.fn(async () => ({ message: 'ok' }));
    await applyServiceAreaParticipantsPlanPricingUpdates(
      baseCtx({
        handleUpdate,
        directSupportValues: directSupportCatalog(),
        activityBasedTransportValues: activityTransportCatalog(),
        providerTravelValues: providerTravelCatalog(),
        centreCapitalCostsValues: centreCapitalCatalog(),
      }),
    );

    expect(handleUpdate.mock.calls).toEqual([
      [
        '55369',
        'eNiJpH14PN3',
        'fixture-quote-legacy-pricing',
        {
          itemId: 'ref-direct-support',
          serviceArea: 'NSW($)',
          unit: 'Hour',
          unitAttr: 'Unit (Direct Support)',
          unitPrice: '67.56',
          unitPriceAttr: 'Agreed Unit Price for Direct Support ($)',
        },
        'direct_support',
        'Direct Support',
        'Participants-Service-Plan',
      ],
      [
        '55369',
        'eNiJpH14PN3',
        'fixture-quote-legacy-pricing',
        {
          itemId: 'ref-activity-transport',
          serviceArea: 'NSW($)',
          unit: 'Each',
          unitAttr: 'Unit (Activity Based Transport)',
          unitPrice: '1.00',
          unitPriceAttr: 'Agreed Price for Activity Based Transport ($)',
        },
        'activity_based_transport',
        'Activity Based Transport',
        'Participants-Service-Plan',
      ],
      [
        '55369',
        'eNiJpH14PN3',
        'fixture-quote-legacy-pricing',
        {
          itemId: 'ref-provider-travel',
          serviceArea: 'NSW($)',
          unit: 'Each',
          unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
          unitPrice: '0.99',
          unitPriceAttr: 'Agreed Unit Price for Non-Labour Travel ($)',
        },
        'provider_travel_non_labour_cost',
        'Provider Travel Non Labour Cost',
        'Participants-Service-Plan',
      ],
      [
        '55369',
        'eNiJpH14PN3',
        'fixture-quote-legacy-pricing',
        {
          itemId: 'ref-centre-capital',
          serviceArea: 'NSW($)',
          unit: 'Each',
          unitAttr: 'Unit (Centre Capital Costs)',
          unitPrice: '2.63',
          unitPriceAttr: 'Agreed Unit Price for Centre Capital Costs ($)',
        },
        'centre_capital_cost',
        'Centre Capital Costs',
        'Participants-Service-Plan',
      ],
    ]);
  });

  it('uses different unit-price attribute names from the quote variant for the same catalogs', async () => {
    const quoteCalls = vi.fn(async () => ({ message: 'ok' }));
    const planCalls = vi.fn(async () => ({ message: 'ok' }));
    const shared = {
      directSupportValues: directSupportCatalog(),
      providerTravelValues: providerTravelCatalog(),
    };
    await applyServiceAreaQuotePricingUpdates(baseCtx({ handleUpdate: quoteCalls, ...shared }));
    await applyServiceAreaParticipantsPlanPricingUpdates(baseCtx({ handleUpdate: planCalls, ...shared }));

    expect(quoteCalls.mock.calls.map((c) => c[3].unitPriceAttr)).toEqual([
      'Unit Price for Direct Support($)',
      'Unit Price for Provider Travel($)',
    ]);
    expect(planCalls.mock.calls.map((c) => c[3].unitPriceAttr)).toEqual([
      'Agreed Unit Price for Direct Support ($)',
      'Agreed Unit Price for Non-Labour Travel ($)',
    ]);
  });

  it('skips every catalog that is absent', async () => {
    const handleUpdate = vi.fn(async () => ({ message: 'ok' }));
    await applyServiceAreaParticipantsPlanPricingUpdates(baseCtx({ handleUpdate }));
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('updates only the catalogs that are present', async () => {
    const handleUpdate = vi.fn(async () => ({ message: 'ok' }));
    await applyServiceAreaParticipantsPlanPricingUpdates(
      baseCtx({
        handleUpdate,
        activityBasedTransportValues: activityTransportCatalog(),
        centreCapitalCostsValues: centreCapitalCatalog(),
      }),
    );
    expect(handleUpdate.mock.calls.map((c) => c[4])).toEqual([
      'activity_based_transport',
      'centre_capital_cost',
    ]);
  });

  it('awaits each update before starting the next', async () => {
    const order = [];
    const handleUpdate = vi.fn(async (_w, _b, _i, _m, type) => {
      order.push(`enter:${type}`);
      await Promise.resolve();
      order.push(`exit:${type}`);
      return { message: 'ok' };
    });
    await applyServiceAreaParticipantsPlanPricingUpdates(
      baseCtx({
        handleUpdate,
        providerTravelValues: providerTravelCatalog(),
        centreCapitalCostsValues: centreCapitalCatalog(),
      }),
    );
    expect(order).toEqual([
      'enter:provider_travel_non_labour_cost',
      'exit:provider_travel_non_labour_cost',
      'enter:centre_capital_cost',
      'exit:centre_capital_cost',
    ]);
  });

  it('propagates a rejection and does not attempt the remaining updates', async () => {
    const handleUpdate = vi.fn(async () => {
      throw new Error('validation failed');
    });
    await expect(
      applyServiceAreaParticipantsPlanPricingUpdates(
        baseCtx({
          handleUpdate,
          directSupportValues: directSupportCatalog(),
          centreCapitalCostsValues: centreCapitalCatalog(),
        }),
      ),
    ).rejects.toThrow('validation failed');
    expect(handleUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('processParticipantsServicePlanType', () => {
  let handleUpdate;
  let updateVariablesParticipantsServicePlan;
  let info;
  let warn;

  beforeEach(() => {
    handleUpdate = vi.fn(async () => ({ message: 'Direct Support item updated successfully' }));
    updateVariablesParticipantsServicePlan = vi.fn(async () => ({ message: 'variables updated' }));
    info = vi.fn();
    warn = vi.fn();
  });

  const ctx = (overrides = {}) => ({
    normalizedType: '',
    workspaceId: '55369',
    boardId: 'eNiJpH14PN3',
    items: { id: 'fixture-quote-legacy-pricing' },
    itemsValues: itemsValues(),
    serviceAreaValues: NSW,
    directSupportValues: null,
    activityBasedTransportValues: null,
    providerTravelValues: null,
    centreCapitalCostsValues: null,
    safeGet,
    handleUpdate,
    updateVariablesParticipantsServicePlan,
    info,
    warn,
    req: { id: 'req-1' },
    ...overrides,
  });

  describe('service_area', () => {
    it('returns the not-found error and touches nothing when serviceAreaValues is missing', async () => {
      const result = await processParticipantsServicePlanType(
        ctx({ normalizedType: 'service_area', serviceAreaValues: null, directSupportValues: directSupportCatalog() }),
      );
      expect(result).toEqual({ status: 200, body: { error: 'Service Area Item not found' } });
      expect(handleUpdate).not.toHaveBeenCalled();
      expect(updateVariablesParticipantsServicePlan).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    });

    it('applies every present catalog, then refreshes the plan variables, then logs', async () => {
      const callOrder = [];
      handleUpdate.mockImplementation(async (_w, _b, _i, _m, type) => {
        callOrder.push(`update:${type}`);
        return { message: 'ok' };
      });
      updateVariablesParticipantsServicePlan.mockImplementation(async () => {
        callOrder.push('variables');
        return { message: 'variables updated' };
      });

      const result = await processParticipantsServicePlanType(
        ctx({
          normalizedType: 'service_area',
          directSupportValues: directSupportCatalog(),
          providerTravelValues: providerTravelCatalog(),
        }),
      );

      expect(callOrder).toEqual(['update:direct_support', 'update:provider_travel_non_labour_cost', 'variables']);
      expect(updateVariablesParticipantsServicePlan.mock.calls).toEqual([
        ['55369', 'eNiJpH14PN3', 'fixture-quote-legacy-pricing', itemsValues()],
      ]);
      expect(result).toEqual({ status: 200, body: { message: 'Service area processed' } });
    });

    it('logs the payload and the request under the Xero-Service scope', async () => {
      const values = itemsValues();
      const req = { id: 'req-77' };
      await processParticipantsServicePlanType(ctx({ normalizedType: 'service_area', itemsValues: values, req }));
      expect(info.mock.calls).toEqual([
        ['Xero-Service', 'Service area processed successfully', values, req],
      ]);
    });

    it('logs a null request when none was supplied', async () => {
      await processParticipantsServicePlanType(ctx({ normalizedType: 'service_area', req: undefined }));
      expect(info.mock.calls[0][3]).toBeNull();
    });

    it('still refreshes variables and succeeds when no pricing catalogs resolved', async () => {
      const result = await processParticipantsServicePlanType(ctx({ normalizedType: 'service_area' }));
      expect(handleUpdate).not.toHaveBeenCalled();
      expect(updateVariablesParticipantsServicePlan).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ status: 200, body: { message: 'Service area processed' } });
    });
  });

  describe('direct_support', () => {
    it('returns the not-found error when the direct support catalog is missing', async () => {
      const result = await processParticipantsServicePlanType(ctx({ normalizedType: 'direct_support' }));
      expect(result).toEqual({ status: 200, body: { error: 'Direct Support Item not found' } });
      expect(handleUpdate).not.toHaveBeenCalled();
      expect(updateVariablesParticipantsServicePlan).not.toHaveBeenCalled();
    });

    it('updates with the agreed direct-support attribute name and the Participants-Service-Plan webhook type', async () => {
      const result = await processParticipantsServicePlanType(
        ctx({ normalizedType: 'direct_support', directSupportValues: directSupportCatalog() }),
      );
      expect(handleUpdate.mock.calls).toEqual([
        [
          '55369',
          'eNiJpH14PN3',
          'fixture-quote-legacy-pricing',
          {
            itemId: 'ref-direct-support',
            serviceArea: 'NSW($)',
            unit: 'Hour',
            unitAttr: 'Unit (Direct Support)',
            unitPrice: '67.56',
            unitPriceAttr: 'Agreed Unit Price for Direct Support ($)',
          },
          'direct_support',
          'Direct Support',
          'Participants-Service-Plan',
        ],
      ]);
      expect(result).toEqual({ status: 200, body: { message: 'Direct Support item updated successfully' } });
    });

    it('returns the handleUpdate result verbatim, including a validation failure', async () => {
      handleUpdate.mockResolvedValue({ message: 'Direct Support update failed', error: 'unitPrice is required' });
      const result = await processParticipantsServicePlanType(
        ctx({ normalizedType: 'direct_support', directSupportValues: directSupportCatalog() }),
      );
      expect(result).toEqual({
        status: 200,
        body: { message: 'Direct Support update failed', error: 'unitPrice is required' },
      });
      // The variables refresh still runs even when the update reported an error.
      expect(updateVariablesParticipantsServicePlan).toHaveBeenCalledTimes(1);
    });

    it('refreshes the plan variables after the update, not before', async () => {
      const callOrder = [];
      handleUpdate.mockImplementation(async () => {
        callOrder.push('update');
        return { message: 'ok' };
      });
      updateVariablesParticipantsServicePlan.mockImplementation(async () => {
        callOrder.push('variables');
        return {};
      });
      await processParticipantsServicePlanType(
        ctx({ normalizedType: 'direct_support', directSupportValues: directSupportCatalog() }),
      );
      expect(callOrder).toEqual(['update', 'variables']);
    });
  });

  describe('activity_based_transport', () => {
    it('returns the not-found error when the catalog is missing', async () => {
      const result = await processParticipantsServicePlanType(
        ctx({ normalizedType: 'activity_based_transport' }),
      );
      expect(result).toEqual({ status: 200, body: { error: 'Activity Based Transport Item not found' } });
      expect(handleUpdate).not.toHaveBeenCalled();
      expect(updateVariablesParticipantsServicePlan).not.toHaveBeenCalled();
    });

    it('updates with the agreed transport attribute name and the Participants-Service-Plan webhook type', async () => {
      handleUpdate.mockResolvedValue({ message: 'Activity Based Transport item updated successfully' });
      const result = await processParticipantsServicePlanType(
        ctx({
          normalizedType: 'activity_based_transport',
          activityBasedTransportValues: activityTransportCatalog(),
          serviceAreaValues: VERY_REMOTE,
        }),
      );
      expect(handleUpdate.mock.calls).toEqual([
        [
          '55369',
          'eNiJpH14PN3',
          'fixture-quote-legacy-pricing',
          {
            itemId: 'ref-activity-transport',
            serviceArea: 'Very Remote($)',
            unit: 'Each',
            unitAttr: 'Unit (Activity Based Transport)',
            unitPrice: '1.50',
            unitPriceAttr: 'Agreed Price for Activity Based Transport ($)',
          },
          'activity_based_transport',
          'Activity Based Transport',
          'Participants-Service-Plan',
        ],
      ]);
      expect(result).toEqual({
        status: 200,
        body: { message: 'Activity Based Transport item updated successfully' },
      });
      expect(updateVariablesParticipantsServicePlan).toHaveBeenCalledTimes(1);
    });
  });

  describe('provider_travel_non_labour_cost', () => {
    it('returns the not-found error when the catalog is missing', async () => {
      const result = await processParticipantsServicePlanType(
        ctx({ normalizedType: 'provider_travel_non_labour_cost' }),
      );
      expect(result).toEqual({ status: 200, body: { error: 'Provider Travel Non Labour Cost Item not found' } });
      expect(handleUpdate).not.toHaveBeenCalled();
      expect(updateVariablesParticipantsServicePlan).not.toHaveBeenCalled();
    });

    it('updates with the agreed non-labour travel attribute name', async () => {
      handleUpdate.mockResolvedValue({ message: 'Provider Travel Non Labour Cost item updated successfully' });
      const result = await processParticipantsServicePlanType(
        ctx({
          normalizedType: 'provider_travel_non_labour_cost',
          providerTravelValues: providerTravelCatalog(),
        }),
      );
      expect(handleUpdate.mock.calls[0].slice(0, 6)).toEqual([
        '55369',
        'eNiJpH14PN3',
        'fixture-quote-legacy-pricing',
        {
          itemId: 'ref-provider-travel',
          serviceArea: 'NSW($)',
          unit: 'Each',
          unitAttr: 'Unit (Provider Travel - Non-Labour Cost)',
          unitPrice: '0.99',
          unitPriceAttr: 'Agreed Unit Price for Non-Labour Travel ($)',
        },
        'provider_travel_non_labour_cost',
        'Provider Travel Non Labour Cost',
      ]);
      expect(result).toEqual({
        status: 200,
        body: { message: 'Provider Travel Non Labour Cost item updated successfully' },
      });
      expect(updateVariablesParticipantsServicePlan).toHaveBeenCalledTimes(1);
    });

    it('omits the Participants-Service-Plan webhook type that the sibling cases pass (inconsistency in source)', async () => {
      await processParticipantsServicePlanType(
        ctx({
          normalizedType: 'provider_travel_non_labour_cost',
          providerTravelValues: providerTravelCatalog(),
        }),
      );
      const providerTravelCall = handleUpdate.mock.calls[0];

      handleUpdate.mockClear();
      await processParticipantsServicePlanType(
        ctx({ normalizedType: 'direct_support', directSupportValues: directSupportCatalog() }),
      );
      const directSupportCall = handleUpdate.mock.calls[0];

      expect(providerTravelCall).toHaveLength(6);
      expect(providerTravelCall[6]).toBeUndefined();
      expect(directSupportCall).toHaveLength(7);
      expect(directSupportCall[6]).toBe('Participants-Service-Plan');
    });
  });

  describe('centre_capital_cost', () => {
    it('returns the not-found error when the catalog is missing', async () => {
      const result = await processParticipantsServicePlanType(ctx({ normalizedType: 'centre_capital_cost' }));
      expect(result).toEqual({ status: 200, body: { error: 'Centre Capital Cost Item not found' } });
      expect(handleUpdate).not.toHaveBeenCalled();
      expect(updateVariablesParticipantsServicePlan).not.toHaveBeenCalled();
    });

    it('updates with the Participants-Service-Plan webhook type', async () => {
      handleUpdate.mockResolvedValue({ message: 'Centre Capital Costs item updated successfully' });
      const result = await processParticipantsServicePlanType(
        ctx({ normalizedType: 'centre_capital_cost', centreCapitalCostsValues: centreCapitalCatalog() }),
      );
      expect(handleUpdate.mock.calls[0][4]).toBe('centre_capital_cost');
      expect(handleUpdate.mock.calls[0][5]).toBe('Centre Capital Costs');
      expect(handleUpdate.mock.calls[0][6]).toBe('Participants-Service-Plan');
      expect(handleUpdate.mock.calls[0][3]).toEqual({
        itemId: 'ref-centre-capital',
        serviceArea: 'NSW($)',
        unit: 'Each',
        unitAttr: 'Unit (Centre Capital Costs)',
        unitPrice: '2.63',
        unitPriceAttr: 'Agreed Unit Price for Centre Capital Costs($)',
      });
      expect(result).toEqual({
        status: 200,
        body: { message: 'Centre Capital Costs item updated successfully' },
      });
      expect(updateVariablesParticipantsServicePlan).toHaveBeenCalledTimes(1);
    });

    it('writes an unspaced "Costs($)" attribute name here but a spaced "Costs ($)" one on the service_area sweep (inconsistency in source)', async () => {
      await processParticipantsServicePlanType(
        ctx({ normalizedType: 'centre_capital_cost', centreCapitalCostsValues: centreCapitalCatalog() }),
      );
      const singleCase = handleUpdate.mock.calls[0][3].unitPriceAttr;

      handleUpdate.mockClear();
      await processParticipantsServicePlanType(
        ctx({ normalizedType: 'service_area', centreCapitalCostsValues: centreCapitalCatalog() }),
      );
      const sweepCase = handleUpdate.mock.calls[0][3].unitPriceAttr;

      expect(singleCase).toBe('Agreed Unit Price for Centre Capital Costs($)');
      expect(sweepCase).toBe('Agreed Unit Price for Centre Capital Costs ($)');
      expect(singleCase).not.toBe(sweepCase);
    });
  });

  describe('update_service_plan_variables', () => {
    it('refreshes the variables only and returns their result', async () => {
      updateVariablesParticipantsServicePlan.mockResolvedValue({ message: 'Service Plan variables updated' });
      const values = itemsValues();
      const result = await processParticipantsServicePlanType(
        ctx({
          normalizedType: 'update_service_plan_variables',
          itemsValues: values,
          directSupportValues: directSupportCatalog(),
        }),
      );
      expect(handleUpdate).not.toHaveBeenCalled();
      expect(updateVariablesParticipantsServicePlan.mock.calls).toEqual([
        ['55369', 'eNiJpH14PN3', 'fixture-quote-legacy-pricing', values],
      ]);
      expect(result).toEqual({ status: 200, body: { message: 'Service Plan variables updated' } });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('default branch', () => {
    it('treats an empty type as a plain variables refresh, without warning', async () => {
      updateVariablesParticipantsServicePlan.mockResolvedValue({ message: 'Service Plan variables updated' });
      const result = await processParticipantsServicePlanType(ctx({ normalizedType: '' }));
      expect(result).toEqual({ status: 200, body: { message: 'Service Plan variables updated' } });
      expect(updateVariablesParticipantsServicePlan).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([undefined, null])('treats %s as a plain variables refresh too', async (normalizedType) => {
      await processParticipantsServicePlanType(ctx({ normalizedType }));
      expect(updateVariablesParticipantsServicePlan).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('rejects an unrecognised type with a warning and no side effects', async () => {
      const result = await processParticipantsServicePlanType(
        ctx({ normalizedType: 'support', directSupportValues: directSupportCatalog() }),
      );
      expect(result).toEqual({
        status: 200,
        body: { error: 'Invalid type', message: 'Invalid type in set-unit' },
      });
      expect(handleUpdate).not.toHaveBeenCalled();
      expect(updateVariablesParticipantsServicePlan).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([
        ['Xero-Service', 'Invalid type in set-unit', { type: 'support' }, { id: 'req-1' }],
      ]);
    });

    it('warns with a null request when none was supplied', async () => {
      await processParticipantsServicePlanType(ctx({ normalizedType: 'bogus', req: undefined }));
      expect(warn.mock.calls[0][3]).toBeNull();
    });

    it('does not match a case-shifted or padded type', async () => {
      const result = await processParticipantsServicePlanType(
        ctx({ normalizedType: 'Direct_Support', directSupportValues: directSupportCatalog() }),
      );
      expect(result.body).toEqual({ error: 'Invalid type', message: 'Invalid type in set-unit' });
      expect(handleUpdate).not.toHaveBeenCalled();
    });
  });

  it('reads the item id from items.id for every pricing case', async () => {
    await processParticipantsServicePlanType(
      ctx({
        normalizedType: 'direct_support',
        items: { id: 'item-abc', values: { ignored: true } },
        directSupportValues: directSupportCatalog(),
      }),
    );
    expect(handleUpdate.mock.calls[0][2]).toBe('item-abc');
    expect(updateVariablesParticipantsServicePlan.mock.calls[0][2]).toBe('item-abc');
  });

  it('propagates a handleUpdate rejection instead of returning an error body', async () => {
    handleUpdate.mockRejectedValue(new Error('ISO+ timeout'));
    await expect(
      processParticipantsServicePlanType(
        ctx({ normalizedType: 'direct_support', directSupportValues: directSupportCatalog() }),
      ),
    ).rejects.toThrow('ISO+ timeout');
    expect(updateVariablesParticipantsServicePlan).not.toHaveBeenCalled();
  });
});
