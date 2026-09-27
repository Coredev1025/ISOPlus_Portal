import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  transformInvoiceGeneratorProcessedItem,
  getInvoiceGeneratorData,
} from '../../../src/utils/invoiceGeneratorRouteHelpers.js';
import {
  ATTRIBUTE_NAMES,
  REF_ATTRIBUTE_NAMES,
} from '../../../src/constants/monthlyStatementAttributes.js';
import { NDIS_MASTERPLAN_ATTR } from '../../../src/utils/ndisServiceRecords.js';
import { clearCache, setCachedTransform } from '../../../src/utils/transformCache.js';
import Item from '../../../src/models/Item.js';
import InvoiceNumber from '../../../src/models/InvoiceNumber.js';

// ---------------------------------------------------------------------------
// Collaborators, reproduced from src/routes/items.js (the only caller) minus its
// logging, so the helper runs against the same behaviour it sees in production.
// Everything the module itself computes runs for real, against the in-memory
// Mongo started by test/setup.js.
// ---------------------------------------------------------------------------

const getValueFromFlatData = (item, attributeName) => {
  if (!item?.data) return null;
  const attributeNames = Array.isArray(attributeName) ? attributeName : [attributeName];
  for (const attrName of attributeNames) {
    if (item.data[attrName] !== undefined && item.data[attrName] !== null) return item.data[attrName];
  }
  if (Array.isArray(item.data.values)) {
    for (const attrName of attributeNames) {
      const entry = item.data.values.find((v) => v.attribute?.name === attrName);
      if (entry?.data !== undefined && entry?.data !== null) return entry.data;
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

const extractAllRefIds = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === 'object' && v.id) return v.id.toString();
      if (typeof v === 'string') return v;
      return v?.toString();
    }).filter(Boolean);
  }
  if (typeof value === 'object' && value.id) return [value.id.toString()];
  if (typeof value === 'string') return [value];
  return value ? [value.toString()] : [];
};

const bulkFetchReferenceItemsFromDB = async (workspaceId, boardId, itemIds) => {
  if (!itemIds || itemIds.length === 0) return new Map();
  const uniqueIds = [...new Set(itemIds.filter(Boolean).map((id) => id.toString()))];
  const items = await Item.find({ workspaceId, boardId, itemId: { $in: uniqueIds } }).lean();
  return new Map(items.map((item) => [item.itemId, item]));
};

const getMyAgedCareIdFromProfile = (profileItem) => {
  if (!profileItem) return null;
  const id = getValueFromFlatData(profileItem, [
    REF_ATTRIBUTE_NAMES.PROFILE_MY_AGED_CARE_ID,
    REF_ATTRIBUTE_NAMES.PROFILE_MY_AGED_CARE_ID_ALT,
  ]);
  return id ? String(id) : null;
};

const getFundingSourceNameFromItem = (fsItem) => {
  if (!fsItem) return null;
  const name = getValueFromFlatData(fsItem, [REF_ATTRIBUTE_NAMES.FS_NAME, REF_ATTRIBUTE_NAMES.FS_DEFINITION]);
  if (!name) return null;
  return (typeof name === 'object' && name.name ? name.name : String(name).trim()) || null;
};

const getServiceFromServicePlan = (servicePlanItem) => {
  if (!servicePlanItem) return null;
  const servicePlanIdValue = getValueFromFlatData(servicePlanItem, REF_ATTRIBUTE_NAMES.SERVICE_PLAN_ID);
  if (servicePlanIdValue) {
    const asString = String(servicePlanIdValue).trim();
    if (asString.includes('-')) {
      const parts = asString.split('-');
      const fromId = parts.length >= 2 ? parts.slice(1).join('-').trim() : asString;
      if (fromId) return fromId;
    } else if (asString) {
      return asString;
    }
  }
  const serviceAttr = getValueFromFlatData(servicePlanItem, [REF_ATTRIBUTE_NAMES.SERVICE, 'Service']);
  if (serviceAttr) {
    if (typeof serviceAttr === 'object' && serviceAttr.name) return serviceAttr.name;
    return String(serviceAttr).trim();
  }
  return null;
};

const getServiceIdentifierFromServicePlan = (servicePlanItem) => {
  if (!servicePlanItem) return null;
  const value = getValueFromFlatData(servicePlanItem, [
    REF_ATTRIBUTE_NAMES.SERVICE_ID_ITEM_ID,
    REF_ATTRIBUTE_NAMES.SERVICE_ID_ITEM_ID_ALT,
  ]);
  return value ? String(value) : null;
};

const getItemDescriptionFromServicePlan = (servicePlanItem) => {
  if (!servicePlanItem) return { code: '', description: '' };
  return {
    code: getValueFromFlatData(servicePlanItem, ['Item Description Code', 'Item ID']) || '',
    description: getValueFromFlatData(servicePlanItem, ['Item Description', 'Item']) || '',
  };
};

const getWraparoundDescriptionFromServicePlan = (servicePlanItem) => {
  if (!servicePlanItem) return { code: '', description: '' };
  return {
    code: getValueFromFlatData(servicePlanItem, ['Wraparound Description Code']) || '',
    description: getValueFromFlatData(servicePlanItem, ['Wraparound Description']) || '',
  };
};

const getHealthProfessionalFromServicePlan = (servicePlanItem) => {
  if (!servicePlanItem) return { typeCode: '', typeOther: '' };
  return {
    typeCode: getValueFromFlatData(servicePlanItem, ['Health Professional Type Code']) || '',
    typeOther: getValueFromFlatData(servicePlanItem, ['Health Professional Type']) || '',
  };
};

function makeDeps(overrides = {}) {
  return {
    Item,
    InvoiceNumber,
    getFolderIds: vi.fn(async () => []),
    bulkFetchReferenceItemsFromDB,
    getValueFromFlatData,
    extractRefId,
    extractAllRefIds,
    getServiceFromServicePlan,
    getServiceIdentifierFromServicePlan,
    getItemDescriptionFromServicePlan,
    getWraparoundDescriptionFromServicePlan,
    getHealthProfessionalFromServicePlan,
    getMyAgedCareIdFromProfile,
    getFundingSourceNameFromItem,
    ATTRIBUTE_NAMES,
    REF_ATTRIBUTE_NAMES,
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

/**
 * A Shift Planning row exactly as the sync writes it into Mongo.
 *
 * Defaults Timesheet Approval to 'Approved' (KAN-271's gate in
 * getInvoiceGeneratorData) so every pre-existing fixture here keeps
 * characterizing the filter it was written for, rather than tripping the
 * approval gate incidentally. A test can still override it explicitly, as the
 * approval-gate tests below do.
 */
function shiftDoc(itemId, data, overrides = {}) {
  return {
    workspaceId: 'ws_1',
    boardId: 'bd_1',
    folderId: 'fld_shift',
    itemId,
    data: { [NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL]: 'Approved', ...data },
    createdAt: new Date('2025-03-01T00:00:00.000Z'),
    updatedAt: new Date('2025-03-02T00:00:00.000Z'),
    ...overrides,
  };
}

function processedItemFor(doc, participantName = '') {
  return { item: doc, participantName };
}

function transformContext(overrides = {}) {
  return {
    workspaceId: 'ws_1',
    boardId: 'bd_1',
    refItemsMap: new Map(),
    invoiceNumberMap: new Map(),
    invoiceFileUrlMap: new Map(),
    ATTRIBUTE_NAMES,
    deps: makeDeps(),
    ...overrides,
  };
}

beforeEach(() => {
  // transformCache is a module-level Map that outlives a test; a stale entry
  // would silently satisfy the next test's cache-miss expectations.
  clearCache();
});

describe('transformInvoiceGeneratorProcessedItem', () => {
  it('maps a delivered hourly shift onto the invoice-generator row shape', () => {
    const doc = shiftDoc('itm_1', {
      [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-10T09:00:00Z',
      [ATTRIBUTE_NAMES.ACTUAL_END]: '2025-03-10T11:00:00Z',
      [ATTRIBUTE_NAMES.UNIT]: 'Hour',
      [ATTRIBUTE_NAMES.QUANTITY]: '2',
      [ATTRIBUTE_NAMES.UNIT_PRICE]: '65.5',
      [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '131',
      [ATTRIBUTE_NAMES.GOV_SUBSIDY]: '100',
      [ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION]: '31',
      [ATTRIBUTE_NAMES.ADDITIONAL_NOTES]: 'Morning shift',
      [ATTRIBUTE_NAMES.DELIVERED_BY]: [{ id: 'l1', name: 'Company Workforce' }],
      [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: [{ id: 't1', name: 'Delivered - To be claimed and invoiced.' }],
      [ATTRIBUTE_NAMES.PAYMENT_STATUS]: 'Unpaid',
      [ATTRIBUTE_NAMES.SERVICE_PLAN]: ['sp_1'],
      [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: ['pp_1'],
      [ATTRIBUTE_NAMES.FUNDING_SOURCE]: ['fs_1', 'fs_2'],
    });

    const refItemsMap = new Map([
      ['sp_1', { itemId: 'sp_1', data: { 'Service Plan ID': 'SP-Personal Care', 'Service ID/Item ID': '1_001' } }],
      ['pp_1', { itemId: 'pp_1', data: { 'My Aged Care ID Number': 'AC-9911' } }],
      ['fs_1', { itemId: 'fs_1', data: { 'Funding Stream': 'Home Support Quarterly Budget' } }],
      ['fs_2', { itemId: 'fs_2', data: { 'Funding Stream': 'Primary Supplement' } }],
    ]);

    const result = transformInvoiceGeneratorProcessedItem(
      processedItemFor(doc, 'Jane Roe'),
      transformContext({ refItemsMap }),
    );

    expect(result).toEqual({
      id: 'itm_1',
      paymentStatus: 'Unpaid',
      participant: 'Jane Roe',
      service: 'Personal Care',
      scheduledServiceDate: '2025-03-10T09:00:00Z',
      serviceDeliveryDate: '2025-03-10T11:00:00Z',
      unit: 'Hour',
      quantity: 2,
      unitPrice: 65.5,
      totalAmount: 131,
      govSubsidy: 100,
      participantContribution: 31,
      fundingSource: 'Home Support Quarterly Budget, Primary Supplement',
      transactionStatus: 'Delivered - To be claimed and invoiced.',
      notes: 'Morning shift',
      fileUrl: null,
      invoiceNumber: undefined,
      careRecipientIdentifier: 'AC-9911',
      serviceIdentifier: '1_001',
      deliveredByThirdParty: 'False',
      itemOrWraparound: '',
      itemDescriptionCode: '',
      itemDescription: '',
      wraparoundDescriptionCode: '',
      wraparoundDescription: '',
      prescribedItem: 'N',
      itemPurchasedMethod: undefined,
      loanedByOrganisationName: '',
      loanedByInvoiceNumber: '',
      healthProfessionalTypeCode: '',
      healthProfessionalTypeOther: '',
      itemFirstPayment: 'False',
    });
  });

  it('returns the cached row but takes invoiceNumber and fileUrl from the fresh maps', () => {
    const doc = shiftDoc('itm_cached', { [ATTRIBUTE_NAMES.UNIT]: 'Hour' });
    setCachedTransform('ws_1', 'bd_1', 'itm_cached', {
      id: 'itm_cached',
      service: 'Cached service',
      invoiceNumber: 'OLD-1',
      fileUrl: 'https://old.example.com/a.pdf',
    });

    const result = transformInvoiceGeneratorProcessedItem(
      processedItemFor(doc),
      transformContext({
        invoiceNumberMap: new Map([['itm_cached', 'INV-77']]),
        invoiceFileUrlMap: new Map([['itm_cached', 'https://new.example.com/b.pdf']]),
      }),
    );

    expect(result).toEqual({
      id: 'itm_cached',
      service: 'Cached service',
      invoiceNumber: 'INV-77',
      fileUrl: 'https://new.example.com/b.pdf',
    });
  });

  it('ignores a cache entry older than the item and recomputes', () => {
    const doc = shiftDoc('itm_stale', {
      [ATTRIBUTE_NAMES.UNIT]: 'Hour',
      [ATTRIBUTE_NAMES.QUANTITY]: 3,
    }, { updatedAt: new Date(Date.now() + 60_000) });
    setCachedTransform('ws_1', 'bd_1', 'itm_stale', { id: 'itm_stale', service: 'Stale service' });

    const result = transformInvoiceGeneratorProcessedItem(processedItemFor(doc), transformContext());

    expect(result.service).toBe('');
    expect(result.quantity).toBe(3);
  });

  it('classifies a unit of "item" as Item and copies only the item description fields', () => {
    const doc = shiftDoc('itm_item', {
      [ATTRIBUTE_NAMES.UNIT]: 'Item',
      [ATTRIBUTE_NAMES.SERVICE_PLAN]: ['sp_item'],
    });
    const refItemsMap = new Map([['sp_item', {
      itemId: 'sp_item',
      data: {
        Service: 'Assistive Technology purchase',
        'Item Description Code': 'AT-1234',
        'Item Description': 'Shower chair',
        'Wraparound Description Code': 'WR-9',
        'Wraparound Description': 'Wrap detail',
      },
    }]]);

    const result = transformInvoiceGeneratorProcessedItem(
      processedItemFor(doc),
      transformContext({ refItemsMap }),
    );

    expect(result.itemOrWraparound).toBe('Item');
    expect(result.itemDescriptionCode).toBe('AT-1234');
    expect(result.itemDescription).toBe('Shower chair');
    expect(result.wraparoundDescriptionCode).toBe('');
    expect(result.wraparoundDescription).toBe('');
  });

  it('classifies a wraparound service as Wraparound and copies only the wraparound fields', () => {
    const doc = shiftDoc('itm_wrap', {
      [ATTRIBUTE_NAMES.UNIT]: 'Each',
      [ATTRIBUTE_NAMES.SERVICE_PLAN]: ['sp_wrap'],
    });
    const refItemsMap = new Map([['sp_wrap', {
      itemId: 'sp_wrap',
      data: {
        Service: 'Home Modification Wraparound',
        'Item Description Code': 'IT-1',
        'Item Description': 'Item detail',
        'Wraparound Description Code': 'WR-42',
        'Wraparound Description': 'Ramp installation wraparound',
      },
    }]]);

    const result = transformInvoiceGeneratorProcessedItem(
      processedItemFor(doc),
      transformContext({ refItemsMap }),
    );

    expect(result.itemOrWraparound).toBe('Wraparound');
    expect(result.wraparoundDescriptionCode).toBe('WR-42');
    expect(result.wraparoundDescription).toBe('Ramp installation wraparound');
    expect(result.itemDescriptionCode).toBe('');
    expect(result.itemDescription).toBe('');
  });

  it('marks deliveredByThirdParty True only when Delivered by mentions Associated', () => {
    const associated = shiftDoc('itm_ap', {
      [ATTRIBUTE_NAMES.DELIVERED_BY]: [{ id: 'l2', name: 'Associated Providers' }],
    });
    const workforce = shiftDoc('itm_cw', {
      [ATTRIBUTE_NAMES.DELIVERED_BY]: 'Company Workforce',
    });

    expect(transformInvoiceGeneratorProcessedItem(processedItemFor(associated), transformContext())
      .deliveredByThirdParty).toBe('True');
    expect(transformInvoiceGeneratorProcessedItem(processedItemFor(workforce), transformContext())
      .deliveredByThirdParty).toBe('False');
  });

  it.each([
    [true, 'Y'],
    ['true', 'Y'],
    ['Y', 'Y'],
    ['y', 'N'],
    [false, 'N'],
    [undefined, 'N'],
  ])('maps Prescribed Item %o to %s', (raw, expected) => {
    const doc = shiftDoc(`itm_presc_${String(raw)}`, { 'Prescribed Item': raw });
    const result = transformInvoiceGeneratorProcessedItem(processedItemFor(doc), transformContext());
    expect(result.prescribedItem).toBe(expected);
  });

  it.each([
    [true, 'True'],
    [false, 'False'],
    ['Yes', 'True'],
    ['  TRUE ', 'True'],
    ['n', 'False'],
    ['Y', 'True'],
    [1, 'False'],
    [undefined, 'False'],
  ])('maps Item First Payment %o to %s', (raw, expected) => {
    const doc = shiftDoc(`itm_first_${String(raw)}`, { 'Item First Payment': raw });
    const result = transformInvoiceGeneratorProcessedItem(processedItemFor(doc), transformContext());
    expect(result.itemFirstPayment).toBe(expected);
  });

  it('resolves a loaned purchase method and carries the lender fields', () => {
    const doc = shiftDoc('itm_loan', {
      'Item Purchased Method': [{ id: 'm1', name: 'Loaned by third party' }],
      'If Loaned, Lender Name': { id: 'o1', name: 'Community Equipment Co' },
      'If Loaned, Lender Invoice No.': 'LEND-55',
    });

    const result = transformInvoiceGeneratorProcessedItem(processedItemFor(doc), transformContext());

    expect(result.itemPurchasedMethod).toBe('LOANED');
    expect(result.loanedByOrganisationName).toBe('Community Equipment Co');
    expect(result.loanedByInvoiceNumber).toBe('LEND-55');
  });

  it('blanks the lender fields when the purchase method is not a loan', () => {
    const doc = shiftDoc('itm_purch', {
      'Item Purchased Method': 'Purchased outright',
      'If Loaned, Lender Name': 'Should be ignored',
      'If Loaned, Lender Invoice No.': 'LEND-56',
    });

    const result = transformInvoiceGeneratorProcessedItem(processedItemFor(doc), transformContext());

    expect(result.itemPurchasedMethod).toBe('PURCHASED');
    expect(result.loanedByOrganisationName).toBe('');
    expect(result.loanedByInvoiceNumber).toBe('');
  });

  it('drops funding sources whose reference item is missing and returns undefined when none resolve', () => {
    const doc = shiftDoc('itm_fs', {
      [ATTRIBUTE_NAMES.FUNDING_SOURCE]: ['fs_missing'],
    });

    const result = transformInvoiceGeneratorProcessedItem(processedItemFor(doc), transformContext());

    expect(result.fundingSource).toBeUndefined();
  });

  it('caches the computed row under the item id', () => {
    const doc = shiftDoc('itm_cache_write', { [ATTRIBUTE_NAMES.QUANTITY]: 4 });
    const first = transformInvoiceGeneratorProcessedItem(processedItemFor(doc), transformContext());

    // Same item id, different data: a cache hit must return the first result.
    const changed = shiftDoc('itm_cache_write', { [ATTRIBUTE_NAMES.QUANTITY]: 99 });
    const second = transformInvoiceGeneratorProcessedItem(processedItemFor(changed), transformContext());

    expect(first.quantity).toBe(4);
    expect(second.quantity).toBe(4);
  });
});

describe('getInvoiceGeneratorData', () => {
  const baseQueryArgs = { workspaceId: 'ws_1', boardId: 'bd_1', req: null };

  async function seedShifts(docs) {
    await Item.insertMany(docs);
  }

  it('returns transformed rows with totals summed over every filtered row', async () => {
    await seedShifts([
      shiftDoc('itm_a', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z',
        [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '100.50',
        [ATTRIBUTE_NAMES.GOV_SUBSIDY]: '70.25',
        [ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION]: '30.25',
      }),
      shiftDoc('itm_b', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-02T09:00:00Z',
        [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '49.50',
        [ATTRIBUTE_NAMES.GOV_SUBSIDY]: '29.75',
        [ATTRIBUTE_NAMES.PARTICIPANT_CONTRIBUTION]: '19.75',
      }),
    ]);

    const result = await getInvoiceGeneratorData({ ...baseQueryArgs, query: {} }, makeDeps());

    expect(result.items.map((row) => row.id)).toEqual(['itm_a', 'itm_b']);
    expect(result.total).toBe(2);
    expect(result.totalAmount).toBe(150);
    expect(result.totalGovSubsidy).toBe(100);
    expect(result.totalParticipantContribution).toBe(50);
  });

  it('counts every filtered row in the totals even when only one page is returned', async () => {
    await seedShifts([
      shiftDoc('itm_p1', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z', [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '10' }),
      shiftDoc('itm_p2', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-02T09:00:00Z', [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '20' }),
      shiftDoc('itm_p3', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-03T09:00:00Z', [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '30' }),
    ]);

    const result = await getInvoiceGeneratorData(
      { ...baseQueryArgs, query: { page: '2', limit: '2' } },
      makeDeps(),
    );

    expect(result.items.map((row) => row.id)).toEqual(['itm_p3']);
    expect(result.total).toBe(3);
    expect(result.totalAmount).toBe(60);
  });

  it('treats limit=all as no pagination', async () => {
    await seedShifts([
      shiftDoc('itm_all1', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z' }),
      shiftDoc('itm_all2', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-02T09:00:00Z' }),
      shiftDoc('itm_all3', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-03T09:00:00Z' }),
    ]);

    const result = await getInvoiceGeneratorData(
      { ...baseQueryArgs, query: { limit: 'all', page: '3' } },
      makeDeps(),
    );

    expect(result.items).toHaveLength(3);
  });

  it('filters on the scheduled start date range inclusively', async () => {
    await seedShifts([
      shiftDoc('itm_before', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-02-28T23:59:59Z' }),
      shiftDoc('itm_start', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T00:00:00Z' }),
      shiftDoc('itm_end', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-31T23:59:59Z' }),
      shiftDoc('itm_after', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-04-01T00:00:00Z' }),
      shiftDoc('itm_nodate', { [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '5' }),
    ]);

    const result = await getInvoiceGeneratorData(
      {
        ...baseQueryArgs,
        query: { startDate: '2025-03-01T00:00:00Z', endDate: '2025-03-31T23:59:59Z' },
      },
      makeDeps(),
    );

    expect(result.items.map((row) => row.id)).toEqual(['itm_start', 'itm_end']);
    expect(result.total).toBe(2);
  });

  // This test used to seed itm_delivered_out with a scheduled start of
  // 2025-03-02 — inside the window — and assert it was excluded. That
  // expectation encoded the single-field filter that was the defect: spec 2.1
  // qualifies an item when EITHER date falls in the period, so a row scheduled
  // in March belongs on a March invoice however late it was delivered. The
  // fixture now puts both of itm_delivered_out's dates outside the window, so
  // the assertion still holds and holds for the right reason.
  it('filters on either date independently of the scheduled range', async () => {
    await seedShifts([
      shiftDoc('itm_delivered_in', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-02-27T09:00:00Z',
        [ATTRIBUTE_NAMES.ACTUAL_END]: '2025-03-02T09:00:00Z',
      }),
      shiftDoc('itm_scheduled_in', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-02T09:00:00Z',
        [ATTRIBUTE_NAMES.ACTUAL_END]: '2025-04-02T09:00:00Z',
      }),
      shiftDoc('itm_delivered_out', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-02-02T09:00:00Z',
        [ATTRIBUTE_NAMES.ACTUAL_END]: '2025-04-02T09:00:00Z',
      }),
    ]);

    const result = await getInvoiceGeneratorData(
      {
        ...baseQueryArgs,
        query: { serviceDeliveryStart: '2025-03-01T00:00:00Z', serviceDeliveryEnd: '2025-03-31T23:59:59Z' },
      },
      makeDeps(),
    );

    expect(result.items.map((row) => row.id)).toEqual(['itm_delivered_in', 'itm_scheduled_in']);
  });

  // Spec 2.1 is an OR across the type's two date fields. A SaH row that was
  // cancelled or is an adjustment never gets an Actual Shift End, so a
  // service-delivery window reading only that field never lists it, selection
  // never sees it and it is never billed. Breaks if the OR loses its scheduled
  // leg again.
  it('lists a cancelled row whose scheduled start falls in the service-delivery window', async () => {
    await seedShifts([
      shiftDoc('itm_cancelled_no_end', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-10T09:00:00Z',
        [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Cancelled - To be claimed and invoiced if applicable',
      }),
    ]);

    const result = await getInvoiceGeneratorData(
      {
        ...baseQueryArgs,
        query: { serviceDeliveryStart: '2025-03-01T00:00:00Z', serviceDeliveryEnd: '2025-03-31T23:59:59Z' },
      },
      makeDeps(),
    );

    expect(result.items.map((row) => row.id)).toEqual(['itm_cancelled_no_end']);
  });

  // The other direction: widening the window must not start listing a row that
  // neither date puts inside it.
  it('still excludes a row with neither date inside the service-delivery window', async () => {
    await seedShifts([
      shiftDoc('itm_outside_both', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-01-10T09:00:00Z',
        [ATTRIBUTE_NAMES.ACTUAL_END]: '2025-01-11T09:00:00Z',
      }),
    ]);

    const result = await getInvoiceGeneratorData(
      {
        ...baseQueryArgs,
        query: { serviceDeliveryStart: '2025-03-01T00:00:00Z', serviceDeliveryEnd: '2025-03-31T23:59:59Z' },
      },
      makeDeps(),
    );

    expect(result.items).toEqual([]);
  });

  // Spec 2.4: both spellings of the same field reach us, and which one a row
  // carries depends on when it was synced.
  it('reads the scheduled start under both spellings for the service-delivery window', async () => {
    await seedShifts([
      shiftDoc('itm_and_spelling', {
        'Scheduled Shift Start Date and Time': '2025-03-10T09:00:00Z',
      }),
    ]);

    const result = await getInvoiceGeneratorData(
      {
        ...baseQueryArgs,
        query: { serviceDeliveryStart: '2025-03-01T00:00:00Z', serviceDeliveryEnd: '2025-03-31T23:59:59Z' },
      },
      makeDeps(),
    );

    expect(result.items.map((row) => row.id)).toEqual(['itm_and_spelling']);
  });

  it('matches the participant filter case-insensitively against the resolved profile name', async () => {
    await Item.insertMany([
      { workspaceId: 'ws_1', boardId: 'bd_1', folderId: 'fld_profiles', itemId: 'pp_jane', data: { 'Full Name/Preferred Name': 'Jane Roe' } },
      { workspaceId: 'ws_1', boardId: 'bd_1', folderId: 'fld_profiles', itemId: 'pp_john', data: { 'Full Name/Preferred Name': 'John Doe' } },
      shiftDoc('itm_jane', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z',
        [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: ['pp_jane'],
      }),
      shiftDoc('itm_john', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-02T09:00:00Z',
        [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: ['pp_john'],
      }),
    ]);

    const result = await getInvoiceGeneratorData(
      { ...baseQueryArgs, query: { participant: 'jane roe' } },
      makeDeps(),
    );

    expect(result.items.map((row) => row.id)).toEqual(['itm_jane']);
    expect(result.items[0].participant).toBe('Jane Roe');
  });

  it('filters on transaction status and payment status, ignoring the literal "all"', async () => {
    await seedShifts([
      shiftDoc('itm_inv', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z',
        [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: [{ id: 't1', name: 'Invoiced' }],
        [ATTRIBUTE_NAMES.PAYMENT_STATUS]: [{ id: 'p1', name: 'Paid' }],
      }),
      shiftDoc('itm_pending', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-02T09:00:00Z',
        [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: [{ id: 't2', name: 'Pending' }],
        [ATTRIBUTE_NAMES.PAYMENT_STATUS]: [{ id: 'p2', name: 'Unpaid' }],
      }),
    ]);

    const filtered = await getInvoiceGeneratorData(
      { ...baseQueryArgs, query: { transactionStatus: 'Invoiced', paymentStatus: 'Paid' } },
      makeDeps(),
    );
    const unfiltered = await getInvoiceGeneratorData(
      { ...baseQueryArgs, query: { transactionStatus: 'all', paymentStatus: 'all' } },
      makeDeps(),
    );

    expect(filtered.items.map((row) => row.id)).toEqual(['itm_inv']);
    expect(unfiltered.items).toHaveLength(2);
  });

  it('sorts by scheduled date descending and puts rows without a date last', async () => {
    await seedShifts([
      shiftDoc('itm_mid', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-02T09:00:00Z' }),
      shiftDoc('itm_late', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-03T09:00:00Z' }),
      shiftDoc('itm_none', { [ATTRIBUTE_NAMES.TOTAL_AMOUNT]: '1' }),
      shiftDoc('itm_early', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z' }),
    ]);

    const result = await getInvoiceGeneratorData(
      { ...baseQueryArgs, query: { sortBy: 'scheduledServiceDate', sortOrder: 'desc' } },
      makeDeps(),
    );

    expect(result.items.map((row) => row.id)).toEqual(['itm_late', 'itm_mid', 'itm_early', 'itm_none']);
  });

  it('breaks a scheduled-date tie with the most recently updated row first', async () => {
    await seedShifts([
      shiftDoc('itm_older', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z' }, {
        updatedAt: new Date('2025-03-05T00:00:00.000Z'),
      }),
      shiftDoc('itm_newer', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z' }, {
        updatedAt: new Date('2025-03-09T00:00:00.000Z'),
      }),
    ]);

    const result = await getInvoiceGeneratorData({ ...baseQueryArgs, query: {} }, makeDeps());

    expect(result.items.map((row) => row.id)).toEqual(['itm_newer', 'itm_older']);
  });

  it('sorts by updatedAt when asked, without the secondary tiebreak', async () => {
    await seedShifts([
      shiftDoc('itm_u_new', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z' }, {
        updatedAt: new Date('2025-03-20T00:00:00.000Z'),
      }),
      shiftDoc('itm_u_old', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-09T09:00:00Z' }, {
        updatedAt: new Date('2025-03-10T00:00:00.000Z'),
      }),
    ]);

    const result = await getInvoiceGeneratorData(
      { ...baseQueryArgs, query: { sortBy: 'updatedAt', sortOrder: 'asc' } },
      makeDeps(),
    );

    expect(result.items.map((row) => row.id)).toEqual(['itm_u_old', 'itm_u_new']);
  });

  it('restricts the query to the folders the folder resolver returns', async () => {
    await seedShifts([
      shiftDoc('itm_in_folder', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z' }),
      shiftDoc('itm_other_folder', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-02T09:00:00Z' }, {
        folderId: 'fld_other',
      }),
    ]);
    const deps = makeDeps({ getFolderIds: vi.fn(async () => ['fld_shift']) });

    const result = await getInvoiceGeneratorData({ ...baseQueryArgs, query: {} }, deps);

    expect(deps.getFolderIds).toHaveBeenCalledWith('Master Plan,Shift Planning and Reporting', 'ws_1', 'bd_1');
    expect(result.items.map((row) => row.id)).toEqual(['itm_in_folder']);
  });

  it('attaches the stored PDF invoice number and link to the matching rows', async () => {
    await seedShifts([shiftDoc('itm_inv_num', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z' })]);
    await InvoiceNumber.create({
      workspaceId: 'ws_1',
      boardId: 'bd_1',
      itemId: 'itm_inv_num',
      invoiceNumber: 'INV-2025-0007 (ISO+™)',
      type: 'PDF',
      pdfLink: 'https://s3.example.com/inv.pdf',
    });
    await InvoiceNumber.create({
      workspaceId: 'ws_1',
      boardId: 'bd_1',
      itemId: 'itm_inv_num',
      invoiceNumber: 'XERO-1',
      type: 'Xero',
    });

    const result = await getInvoiceGeneratorData({ ...baseQueryArgs, query: {} }, makeDeps());

    expect(result.items[0].invoiceNumber).toBe('INV-2025-0007 (ISO+™)');
    expect(result.items[0].fileUrl).toBe('https://s3.example.com/inv.pdf');
  });

  it('returns a 500 error envelope when the item query fails', async () => {
    const dbErr = new Error('connection reset');
    const deps = makeDeps({
      Item: { find: () => ({ lean: async () => { throw dbErr; } }) },
    });

    const result = await getInvoiceGeneratorData({ ...baseQueryArgs, query: {} }, deps);

    expect(result).toEqual({
      error: {
        status: 500,
        body: { message: 'Error fetching invoice generator data', error: 'connection reset' },
      },
    });
    expect(deps.error).toHaveBeenCalledWith(
      'Items-Service',
      'Database query error',
      expect.objectContaining({ message: 'connection reset', workspaceId: 'ws_1', boardId: 'bd_1' }),
      null,
    );
  });

  it('coerces a non-string workspaceId to an empty string, which matches nothing', async () => {
    await seedShifts([shiftDoc('itm_ws', { [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z' })]);

    const result = await getInvoiceGeneratorData(
      { workspaceId: { $ne: '' }, boardId: 'bd_1', query: {}, req: null },
      makeDeps(),
    );

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('resolves nested service-plan references before transforming', async () => {
    await Item.insertMany([
      {
        workspaceId: 'ws_1',
        boardId: 'bd_1',
        folderId: 'fld_plans',
        itemId: 'sp_nested',
        data: { Service: 'Nursing', 'Home Support (HS)': ['hs_ref'] },
      },
      {
        workspaceId: 'ws_1',
        boardId: 'bd_1',
        folderId: 'fld_refs',
        itemId: 'hs_ref',
        data: { 'Item Description Code': 'HS-1', 'Item Description': 'Nursing visit' },
      },
      shiftDoc('itm_nested', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z',
        [ATTRIBUTE_NAMES.SERVICE_PLAN]: ['sp_nested'],
      }),
    ]);
    const deps = makeDeps();

    const result = await getInvoiceGeneratorData({ ...baseQueryArgs, query: {} }, deps);

    expect(result.items[0].service).toBe('Nursing');
    expect(deps.info).toHaveBeenCalledWith(
      'Items-Service',
      'Bulk fetched reference items from DB (invoice-generator)',
      expect.objectContaining({ servicePlans: 1, nestedRefs: 1, totalFound: 2 }),
      null,
    );
  });

  // --- characterization of two defects in processInvoiceGeneratorItems -------

  it('throws when a participant profile reference points at a row that is not in the database', async () => {
    await seedShifts([
      shiftDoc('itm_missing_profile', {
        [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: ['pp_does_not_exist'],
      }),
    ]);

    await expect(
      getInvoiceGeneratorData({ ...baseQueryArgs, query: {} }, makeDeps()),
    ).rejects.toThrow(TypeError);
  });

  it('reads only the first character when the participant profile is a bare string', async () => {
    await Item.insertMany([
      {
        workspaceId: 'ws_1',
        boardId: 'bd_1',
        folderId: 'fld_profiles',
        itemId: 'p',
        data: { 'Full Name/Preferred Name': 'Single Letter Row' },
      },
      shiftDoc('itm_string_profile', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z',
        [ATTRIBUTE_NAMES.PARTICIPANT_PROFILE]: 'pp_jane',
      }),
    ]);

    const result = await getInvoiceGeneratorData(
      { ...baseQueryArgs, query: { participant: 'Single Letter Row' } },
      makeDeps(),
    );

    expect(result.items.map((row) => row.id)).toEqual(['itm_string_profile']);
  });

  // KAN-271: SaH boards carry the same Timesheet Approval attribute NDIS
  // boards gate on (confirmed live, workspace 55369, 2026-09-28), but this
  // list previously had no approval check at all — only Transaction Status.
  // A row pending approval must not appear here, since this same list feeds
  // both the manual Invoice Generator and automated SaH invoicing
  // (services/automation/generateDocuments.js's generateAgeCareGeneratorInvoices).
  it('excludes an item pending timesheet approval even when its transaction status qualifies', async () => {
    await seedShifts([
      shiftDoc('itm_pending_approval', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-01T09:00:00Z',
        [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Delivered - To be claimed and invoiced.',
        [NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL]: 'Pending',
      }),
      shiftDoc('itm_approved', {
        [ATTRIBUTE_NAMES.SCHEDULED_START]: '2025-03-02T09:00:00Z',
        [ATTRIBUTE_NAMES.TRANSACTION_STATUS]: 'Delivered - To be claimed and invoiced.',
        [NDIS_MASTERPLAN_ATTR.TIMESHEET_APPROVAL]: 'Approved',
      }),
    ]);

    const result = await getInvoiceGeneratorData({ ...baseQueryArgs, query: {} }, makeDeps());

    expect(result.items.map((row) => row.id)).toEqual(['itm_approved']);
    expect(result.total).toBe(1);
  });
});
