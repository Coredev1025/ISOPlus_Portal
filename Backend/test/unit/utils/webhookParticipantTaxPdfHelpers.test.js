import { describe, it, expect, vi, beforeEach } from 'vitest';

// External boundaries only: PDF rendering, the ISO+ HTTP API and the audit
// collection. Everything the module actually computes — reference collection,
// receiver resolution, row building, totals, template choice, filenames — runs
// for real, against the committed src/assets templates and the in-memory Mongo
// started by test/setup.js.
vi.mock('@pdfme/generator', () => ({ generate: vi.fn() }));
vi.mock('../../../src/services/isoplus.js', () => ({
  validateItemBelongsToTenant: vi.fn(),
  setIntegrationMessage: vi.fn(),
  setGeneratedField: vi.fn(),
}));
vi.mock('../../../src/utils/auditLogger.js', () => ({ logAuditTrail: vi.fn() }));

const { generate } = await import('@pdfme/generator');
const isoplus = await import('../../../src/services/isoplus.js');
const { logAuditTrail } = await import('../../../src/utils/auditLogger.js');
const Board = (await import('../../../src/models/Board.js')).default;
const Item = (await import('../../../src/models/Item.js')).default;
const Business = (await import('../../../src/models/Business.js')).default;

const {
  resolveLowCatBoardFlag,
  fetchValidatedDbItems,
  collectParticipantTaxReferenceIds,
  resolveParticipantTaxReceiverDetails,
  buildParticipantTaxOrders,
  generateParticipantTaxInvoicePdf,
  handleParticipantTaxInvoiceRoute,
} = await import('../../../src/utils/webhookParticipantTaxPdfHelpers.js');

// ---------------------------------------------------------------------------
// Collaborators, reproduced from src/routes/webhook.js (the only caller) so the
// helpers are exercised against the same behaviour they see in production.
// ---------------------------------------------------------------------------

const ATTRIBUTE_NAMES = {
  SCHEDULED_START: 'Scheduled Shift Start Date & Time',
  ACTUAL_END: 'Actual Shift End Date & Time',
  UNIT: 'Unit',
  QUANTITY: 'Quantity',
  UNIT_PRICE: 'Unit Price ($)',
  TOTAL_AMOUNT: 'Total Amount ($)',
  PARTICIPANT_CONTRIBUTION: 'Participant Contribution ($)',
  SERVICE_PLAN: 'Service Plan',
  ADDITIONAL_NOTES: 'Additional Notes',
  TRANSACTION_STATUS: 'Transaction Status',
  PARTICIPANT_PROFILE: 'Participant Profile',
};

const REF_ATTRIBUTE_NAMES = {
  PROFILE_FULL_NAME: 'Full Name/Preferred Name',
  PROFILE_PREFERRED_NAME: 'Preferred Name',
  PROFILE_BILLING_CONTACT: 'Billing Contact',
  PROFILE_BILLING_ADDRESS: 'Billing Address',
  SERVICE_PLAN_ID: 'Service Plan ID',
};

function getValueFromFlatData(item, attributeName) {
  if (!item?.data) return null;
  const names = Array.isArray(attributeName) ? attributeName : [attributeName];
  for (const attrName of names) {
    if (item.data[attrName] !== undefined && item.data[attrName] !== null) {
      return item.data[attrName];
    }
  }
  if (Array.isArray(item.data.values)) {
    for (const attrName of names) {
      const entry = item.data.values.find((v) => v.attribute?.name === attrName);
      if (entry?.data !== undefined && entry?.data !== null) return entry.data;
    }
  }
  return null;
}

function getParticipantNameFromProfile(profileItem) {
  if (!profileItem) return null;
  const name = getValueFromFlatData(profileItem, [
    REF_ATTRIBUTE_NAMES.PROFILE_PREFERRED_NAME,
    REF_ATTRIBUTE_NAMES.PROFILE_FULL_NAME,
    'Full Name', 'Preferred Name', 'Name',
  ]);
  if (!name) return null;
  if (typeof name === 'object' && name.name) return name.name;
  return String(name);
}

function getServiceFromServicePlan(servicePlanItem) {
  if (!servicePlanItem) return null;
  const value = getValueFromFlatData(servicePlanItem, REF_ATTRIBUTE_NAMES.SERVICE_PLAN_ID);
  if (!value) return null;
  const str = String(value).trim();
  if (str.includes(' - ')) {
    const parts = str.split(' - ');
    return parts.length >= 2 ? parts[1].trim() : str;
  }
  if (str.includes('-')) {
    const parts = str.split('-');
    return parts.length >= 2 ? parts.slice(1).join('-').trim() : str;
  }
  return str;
}

function formatLabelValue(value, labels = []) {
  if (!value) return '';
  if (Array.isArray(value) && value.length > 0) {
    return value.map((id) => {
      if (typeof id === 'object' && id.name) return id.name;
      const label = labels.find((l) => l.id === id);
      return label ? label.name : String(id);
    }).filter(Boolean).join(', ');
  }
  if (typeof value === 'object' && value.name) return value.name;
  if (typeof value === 'string') return value;
  return String(value);
}

function formatValue(val) {
  const num = Number(val);
  if (Number.isNaN(num)) return val;
  return (Math.round(num * 100) / 100).toFixed(2);
}

function formatCurrencyValue(value) {
  const num = Number(value) || 0;
  const formatted = formatValue(num);
  return num < 0 ? `-$${formatted.replace(/^-/, '')}` : `$${formatted}`;
}

function enableRepeatHeadOnTables(template) {
  if (!template || !Array.isArray(template.schemas)) return;
  for (const pageSchemas of template.schemas) {
    if (!Array.isArray(pageSchemas)) continue;
    for (const schema of pageSchemas) {
      if (schema && schema.type === 'table') schema.repeatHead = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures — real ISO+ service-record / profile / service-plan document shapes.
// ---------------------------------------------------------------------------

const deliveredRecord = () => ({
  workspaceId: 'ws_1',
  boardId: 'b_1',
  itemId: 'item_1',
  data: {
    'Transaction Status': [{ id: 'ts_del', name: 'Delivered - To be claimed and invoiced.' }],
    'Scheduled Shift Start Date & Time': '2026-03-04T01:00:00Z',
    'Actual Shift End Date & Time': '2026-03-04T05:00:00Z',
    'Participant Profile': [{ id: 'pp_1', name: 'Jane Citizen' }],
    'Service Plan': [{ id: 'sp_1', name: '01_011_0107_1_1' }],
    Unit: 'Hour',
    Quantity: 2,
    'Unit Price ($)': 65.5,
    'Total Amount ($)': 131,
    'Participant Contribution ($)': 25.75,
  },
});

const adjustmentRecord = () => ({
  workspaceId: 'ws_1',
  boardId: 'b_1',
  itemId: 'item_2',
  data: {
    'Transaction Status': 'Adjustment (Charge) - To be claimed and invoiced.',
    'Scheduled Shift Start Date & Time': '2026-03-10T22:30:00Z',
    'Participant Profile': [{ id: 'pp_1', name: 'Jane Citizen' }],
    'Additional Notes': '<p>Late cancellation <b>fee</b></p>',
    Quantity: '1',
    'Unit Price ($)': 20,
    'Total Amount ($)': 20,
    'Participant Contribution ($)': 20,
  },
});

const participantProfileItem = () => ({
  itemId: 'pp_1',
  data: {
    'Full Name/Preferred Name': 'Jane Citizen',
    'Billing Contact': 'Bob Citizen',
    'Billing Address': '  12 Example St, Sydney NSW 2000  ',
  },
});

const servicePlanItem = () => ({
  itemId: 'sp_1',
  data: { 'Service Plan ID': '01_011_0107_1_1 - Assistance With Self-Care' },
});

const refMap = (...items) => new Map(items.map((i) => [i.itemId, i]));

const orderCtx = (overrides = {}) => ({
  getValueFromFlatData,
  attributeNames: ATTRIBUTE_NAMES,
  refAttributeNames: REF_ATTRIBUTE_NAMES,
  refItemsMap: refMap(participantProfileItem(), servicePlanItem()),
  isLowCatBoard: false,
  participantName: 'Jane Citizen',
  formatLabelValue,
  getParticipantNameFromProfile,
  getServiceFromServicePlan,
  dateFmt: (d) => (d
    ? new Date(d).toLocaleString('en-AU', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Australia/Sydney',
    })
    : ''),
  fmt: (v) => formatValue(typeof v === 'number' ? v : Number(v || 0)),
  formatCurrencyValue,
  ...overrides,
});

// ---------------------------------------------------------------------------

describe('collectParticipantTaxReferenceIds', () => {
  it('collects and de-duplicates participant-profile and service-plan ids across items', () => {
    const items = [
      deliveredRecord(),
      { data: { 'Participant Profile': [{ id: 'pp_1' }], 'Service Plan': [{ id: 'sp_2' }] } },
      { data: { 'Participant Profile': 'pp_3', 'Service Plan': { id: 'sp_1' } } },
    ];

    const { participantProfileIds, servicePlanIds } =
      collectParticipantTaxReferenceIds(items, getValueFromFlatData, ATTRIBUTE_NAMES);

    expect([...participantProfileIds]).toEqual(['pp_1', 'pp_3']);
    expect([...servicePlanIds]).toEqual(['sp_1', 'sp_2']);
  });

  it('skips items whose references are missing entirely', () => {
    const items = [adjustmentRecord(), { data: {} }, { itemId: 'no_data' }];

    const { participantProfileIds, servicePlanIds } =
      collectParticipantTaxReferenceIds(items, getValueFromFlatData, ATTRIBUTE_NAMES);

    expect([...participantProfileIds]).toEqual(['pp_1']);
    expect([...servicePlanIds]).toEqual([]);
  });

  it('returns two empty sets for no items', () => {
    const { participantProfileIds, servicePlanIds } =
      collectParticipantTaxReferenceIds([], getValueFromFlatData, ATTRIBUTE_NAMES);

    expect(participantProfileIds.size).toBe(0);
    expect(servicePlanIds.size).toBe(0);
  });
});

describe('resolveParticipantTaxReceiverDetails', () => {
  const helpers = {
    getValueFromFlatData,
    attributeNames: ATTRIBUTE_NAMES,
    refAttributeNames: REF_ATTRIBUTE_NAMES,
    getParticipantNameFromProfile,
  };
  const blank = { participantName: ' ', receiverName: ' ', receiverAddress: ' ' };

  it('reads the name, billing contact and trimmed billing address from the profile', () => {
    const result = resolveParticipantTaxReceiverDetails(
      [deliveredRecord()], refMap(participantProfileItem()), helpers,
    );

    expect(result).toEqual({
      participantName: 'Jane Citizen',
      receiverName: 'Bob Citizen',
      receiverAddress: '12 Example St, Sydney NSW 2000',
    });
  });

  it('uses only the first item, even when later items point at another profile', () => {
    const second = deliveredRecord();
    second.data['Participant Profile'] = [{ id: 'pp_2' }];
    const other = { itemId: 'pp_2', data: { 'Full Name/Preferred Name': 'Other Person' } };

    const result = resolveParticipantTaxReceiverDetails(
      [deliveredRecord(), second], refMap(participantProfileItem(), other), helpers,
    );

    expect(result.participantName).toBe('Jane Citizen');
  });

  it('returns blanks for no items', () => {
    expect(resolveParticipantTaxReceiverDetails([], refMap(), helpers)).toEqual(blank);
  });

  it('returns blanks when the first item has no participant-profile reference', () => {
    expect(resolveParticipantTaxReceiverDetails([{ data: {} }], refMap(participantProfileItem()), helpers))
      .toEqual(blank);
  });

  it('returns blanks when the referenced profile was not fetched', () => {
    expect(resolveParticipantTaxReceiverDetails([deliveredRecord()], refMap(), helpers)).toEqual(blank);
  });

  it('falls back to a single space for a profile with no billing fields', () => {
    const bare = { itemId: 'pp_1', data: { 'Full Name/Preferred Name': 'Jane Citizen' } };

    expect(resolveParticipantTaxReceiverDetails([deliveredRecord()], refMap(bare), helpers)).toEqual({
      participantName: 'Jane Citizen',
      receiverName: ' ',
      receiverAddress: ' ',
    });
  });

  it('collapses a whitespace-only billing address back to a single space', () => {
    const profile = participantProfileItem();
    profile.data['Billing Address'] = '   ';

    expect(resolveParticipantTaxReceiverDetails([deliveredRecord()], refMap(profile), helpers).receiverAddress)
      .toBe(' ');
  });

  it('throws when the billing address is stored as a non-string, because it is trimmed unguarded', () => {
    const profile = participantProfileItem();
    profile.data['Billing Address'] = 2000; // numeric attribute value from ISO+

    expect(() => resolveParticipantTaxReceiverDetails([deliveredRecord()], refMap(profile), helpers))
      .toThrow(TypeError);
  });
});

describe('buildParticipantTaxOrders', () => {
  it('builds 8-column participant-contribution rows and totals only the contributions', () => {
    const { ordersArr, totalParticipantContribution, totalAmountSum } =
      buildParticipantTaxOrders([deliveredRecord(), adjustmentRecord()], orderCtx());

    expect(ordersArr).toEqual([
      ['04/03/2026', 'Assistance With Self-Care', 'Hour', '2.00', '$65.50', 'GST Free', '$131.00', '$25.75'],
      ['11/03/2026', 'Service - Late cancellation fee', ' ', '1.00', '$20.00', 'GST Free', '$20.00', '$20.00'],
    ]);
    expect(totalParticipantContribution).toBe(45.75);
    expect(totalAmountSum).toBe(0);
  });

  it('builds 8-column participant-first rows and totals only the amounts on a low-cat board', () => {
    const { ordersArr, totalParticipantContribution, totalAmountSum } =
      buildParticipantTaxOrders([deliveredRecord(), adjustmentRecord()], orderCtx({ isLowCatBoard: true }));

    expect(ordersArr).toEqual([
      ['Jane Citizen', '04/03/2026', 'Assistance With Self-Care', 'Hour', '2.00', '$65.50', 'GST Free', '$131.00'],
      ['Jane Citizen', '11/03/2026', 'Service - Late cancellation fee', ' ', '1.00', '$20.00', 'GST Free', '$20.00'],
    ]);
    expect(totalAmountSum).toBe(151);
    expect(totalParticipantContribution).toBe(0);
  });

  it('resolves a per-row participant name on a low-cat board from that row own profile', () => {
    const second = deliveredRecord();
    second.itemId = 'item_9';
    second.data['Participant Profile'] = [{ id: 'pp_2' }];
    const other = { itemId: 'pp_2', data: { 'Full Name/Preferred Name': 'Sam Other' } };

    const { ordersArr } = buildParticipantTaxOrders([deliveredRecord(), second], orderCtx({
      isLowCatBoard: true,
      refItemsMap: refMap(participantProfileItem(), servicePlanItem(), other),
    }));

    expect(ordersArr[0][0]).toBe('Jane Citizen');
    expect(ordersArr[1][0]).toBe('Sam Other');
  });

  it('falls back to the document participant name when a row profile is missing or unnamed', () => {
    const noProfile = deliveredRecord();
    delete noProfile.data['Participant Profile'];
    const unfetched = deliveredRecord();
    unfetched.data['Participant Profile'] = [{ id: 'pp_missing' }];
    const unnamed = deliveredRecord();
    unnamed.data['Participant Profile'] = [{ id: 'pp_blank' }];

    const { ordersArr } = buildParticipantTaxOrders([noProfile, unfetched, unnamed], orderCtx({
      isLowCatBoard: true,
      participantName: 'Fallback Name',
      refItemsMap: refMap(servicePlanItem(), { itemId: 'pp_blank', data: {} }),
    }));

    expect(ordersArr.map((row) => row[0])).toEqual(['Fallback Name', 'Fallback Name', 'Fallback Name']);
  });

  describe('the row date', () => {
    it('uses the actual shift end for a delivered record', () => {
      const { ordersArr } = buildParticipantTaxOrders([deliveredRecord()], orderCtx());
      expect(ordersArr[0][0]).toBe('04/03/2026'); // actual end 04/03, scheduled start 04/03 12:00 AEDT
    });

    it('uses the scheduled start for a record that is not delivered', () => {
      const record = deliveredRecord();
      record.data['Transaction Status'] = 'Scheduled - Not yet delivered.';
      record.data['Scheduled Shift Start Date & Time'] = '2026-02-01T03:00:00Z';
      record.data['Actual Shift End Date & Time'] = '2026-12-25T03:00:00Z';

      const { ordersArr } = buildParticipantTaxOrders([record], orderCtx());
      expect(ordersArr[0][0]).toBe('01/02/2026');
    });

    it('falls back to a single space when the chosen date is absent', () => {
      const delivered = deliveredRecord();
      delete delivered.data['Actual Shift End Date & Time'];
      const scheduled = deliveredRecord();
      scheduled.data['Transaction Status'] = 'Scheduled - Not yet delivered.';
      delete scheduled.data['Scheduled Shift Start Date & Time'];

      const { ordersArr } = buildParticipantTaxOrders([delivered, scheduled], orderCtx());
      expect(ordersArr.map((row) => row[0])).toEqual([' ', ' ']);
    });
  });

  describe('the description', () => {
    it('falls back to "Service" when there is no service-plan reference', () => {
      const record = deliveredRecord();
      delete record.data['Service Plan'];

      expect(buildParticipantTaxOrders([record], orderCtx()).ordersArr[0][1]).toBe('Service');
    });

    it('falls back to "Service" when the referenced service plan was not fetched', () => {
      const record = deliveredRecord();
      record.data['Service Plan'] = [{ id: 'sp_missing' }];

      expect(buildParticipantTaxOrders([record], orderCtx()).ordersArr[0][1]).toBe('Service');
    });

    it('falls back to "Service" when the service plan carries no service name', () => {
      const blankPlan = { itemId: 'sp_1', data: {} };

      expect(buildParticipantTaxOrders([deliveredRecord()], orderCtx({
        refItemsMap: refMap(participantProfileItem(), blankPlan),
      })).ordersArr[0][1]).toBe('Service');
    });
  });

  describe('adjustment notes', () => {
    it('appends HTML-stripped notes for a charge adjustment', () => {
      expect(buildParticipantTaxOrders([adjustmentRecord()], orderCtx()).ordersArr[0][1])
        .toBe('Service - Late cancellation fee');
    });

    it('appends notes for a refund adjustment too', () => {
      const record = adjustmentRecord();
      record.data['Transaction Status'] = 'Adjustment (Refund) - To be claimed and invoiced.';
      record.data['Additional Notes'] = 'Overcharged by one hour';

      expect(buildParticipantTaxOrders([record], orderCtx()).ordersArr[0][1])
        .toBe('Service - Overcharged by one hour');
    });

    it('does not append notes for a delivered record', () => {
      const record = deliveredRecord();
      record.data['Additional Notes'] = 'Internal note, not for the invoice';

      expect(buildParticipantTaxOrders([record], orderCtx()).ordersArr[0][1])
        .toBe('Assistance With Self-Care');
    });

    it('leaves the description alone when the notes are absent, empty after stripping, or not a string', () => {
      const noNotes = adjustmentRecord();
      delete noNotes.data['Additional Notes'];
      const onlyMarkup = adjustmentRecord();
      onlyMarkup.data['Additional Notes'] = '<p></p>  <br/>';
      const notAString = adjustmentRecord();
      notAString.data['Additional Notes'] = { text: 'object note' };

      const { ordersArr } = buildParticipantTaxOrders([noNotes, onlyMarkup, notAString], orderCtx());
      expect(ordersArr.map((row) => row[1])).toEqual(['Service', 'Service', 'Service']);
    });
  });

  describe('numeric and unit coercion', () => {
    it('coerces missing or non-numeric amounts to zero and a missing unit to a space', () => {
      const record = deliveredRecord();
      record.data.Unit = '';
      record.data.Quantity = 'not a number';
      delete record.data['Unit Price ($)'];
      delete record.data['Total Amount ($)'];
      delete record.data['Participant Contribution ($)'];

      const { ordersArr, totalParticipantContribution } = buildParticipantTaxOrders([record], orderCtx());

      expect(ordersArr[0]).toEqual(
        ['04/03/2026', 'Assistance With Self-Care', ' ', '0.00', '$0.00', 'GST Free', '$0.00', '$0.00'],
      );
      expect(totalParticipantContribution).toBe(0);
    });

    it('formats a negative refund amount with the minus in front of the dollar sign', () => {
      const record = deliveredRecord();
      record.data['Total Amount ($)'] = -131;
      record.data['Participant Contribution ($)'] = -25.75;

      const { ordersArr, totalParticipantContribution } = buildParticipantTaxOrders([record], orderCtx());

      expect(ordersArr[0][6]).toBe('-$131.00');
      expect(ordersArr[0][7]).toBe('-$25.75');
      expect(totalParticipantContribution).toBe(-25.75);
    });
  });

  it('returns nothing to invoice for an empty item list', () => {
    expect(buildParticipantTaxOrders([], orderCtx())).toEqual({
      ordersArr: [], totalParticipantContribution: 0, totalAmountSum: 0,
    });
  });
});

describe('resolveLowCatBoardFlag', () => {
  beforeEach(async () => {
    await Board.deleteMany({});
  });

  it('trusts an explicit isLowCat flag on the request without touching the database', async () => {
    expect(await resolveLowCatBoardFlag({ body: { isLowCat: true } }, 'b_unknown')).toBe(true);
  });

  it('recognises the low-cat board by its label', async () => {
    await Board.create({ boardId: 'b_low', name: 'SaH', label: 'Care Management - SaH - Low Cat' });

    expect(await resolveLowCatBoardFlag({ body: {} }, 'b_low')).toBe(true);
  });

  it('returns false for a board with any other label', async () => {
    await Board.create({ boardId: 'b_std', name: 'NDIS', label: 'Care Management - NDIS' });

    expect(await resolveLowCatBoardFlag({ body: { isLowCat: false } }, 'b_std')).toBe(false);
  });

  it('returns false when the board is not in the database at all', async () => {
    expect(await resolveLowCatBoardFlag({ body: {} }, 'b_missing')).toBe(false);
  });

  it('tolerates a request with no body', async () => {
    await Board.create({ boardId: 'b_low', name: 'SaH', label: 'Care Management - SaH - Low Cat' });

    expect(await resolveLowCatBoardFlag({}, 'b_low')).toBe(true);
  });
});

describe('fetchValidatedDbItems', () => {
  beforeEach(async () => {
    await Item.deleteMany({});
    isoplus.validateItemBelongsToTenant.mockReset();
    isoplus.validateItemBelongsToTenant.mockResolvedValue(undefined);
  });

  it('validates then loads each item, preserving the requested order', async () => {
    await Item.create([
      { workspaceId: 'ws_1', boardId: 'b_1', folderId: 'f_1', itemId: 'item_1', data: { Unit: 'Hour' } },
      { workspaceId: 'ws_1', boardId: 'b_1', folderId: 'f_1', itemId: 'item_2', data: { Unit: 'Each' } },
    ]);

    const result = await fetchValidatedDbItems('ws_1', 'b_1', ['item_2', 'item_1']);

    expect(result.map((i) => i.itemId)).toEqual(['item_2', 'item_1']);
    expect(result[0].data).toEqual({ Unit: 'Each' });
    expect(isoplus.validateItemBelongsToTenant.mock.calls).toEqual([
      ['ws_1', 'b_1', 'item_2'],
      ['ws_1', 'b_1', 'item_1'],
    ]);
  });

  it('throws naming the item when it is not stored locally', async () => {
    await expect(fetchValidatedDbItems('ws_1', 'b_1', ['item_ghost']))
      .rejects.toThrow('Item item_ghost not found');
  });

  it('does not load an item that belongs to another board', async () => {
    await Item.create({ workspaceId: 'ws_1', boardId: 'b_other', folderId: 'f_1', itemId: 'item_1', data: {} });

    await expect(fetchValidatedDbItems('ws_1', 'b_1', ['item_1'])).rejects.toThrow('Item item_1 not found');
  });

  it('stops at the first tenant-validation failure', async () => {
    isoplus.validateItemBelongsToTenant.mockRejectedValueOnce(new Error('Item does not belong to this tenant'));

    await expect(fetchValidatedDbItems('ws_1', 'b_1', ['item_1', 'item_2']))
      .rejects.toThrow('Item does not belong to this tenant');
    expect(isoplus.validateItemBelongsToTenant).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list for no ids without validating anything', async () => {
    expect(await fetchValidatedDbItems('ws_1', 'b_1', [])).toEqual([]);
    expect(isoplus.validateItemBelongsToTenant).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

// The company details the PDF renders. The invoice NUMBER no longer comes from
// this object: it is claimed atomically from the workspace's Business row (see
// seedBusinessCounter), because a number read off an in-memory copy and written
// back after the render is lost the moment two generations overlap.
function makeBusiness() {
  return {
    name: 'Hillsgrade Care Pty Ltd',
    abn: '12 345 678 901',
    headOfficeTimezone: 'Australia/Sydney',
    address: { street: '5 Depot Rd', suburb: 'Parramatta', state: 'NSW', postcode: '2150', country: 'Australia' },
    bankDetails: { accountName: 'Hillsgrade Care', bankName: 'CBA', bsb: '062-000', accountNumber: '12345678' },
    documentNumbering: { invoice: { prefix: 'INV-', nextNumber: 1001 } },
  };
}

/** The stored counter the run claims from, for a workspace. */
async function seedBusinessCounter(workspaceId, nextNumber = 1001) {
  await Business.deleteMany({ workspaceId });
  await Business.create({
    workspaceId,
    name: 'Hillsgrade Care Pty Ltd',
    documentNumbering: { invoice: { prefix: 'INV-', nextNumber } },
  });
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function pdfDeps(overrides = {}) {
  return {
    getLogoData: vi.fn().mockResolvedValue('data:image/png;base64,AAAA'),
    enableRepeatHeadOnTables,
    bulkFetchReferenceItemsFromDB: vi.fn().mockResolvedValue(refMap(participantProfileItem(), servicePlanItem())),
    getValueFromFlatData,
    attributeNames: ATTRIBUTE_NAMES,
    refAttributeNames: REF_ATTRIBUTE_NAMES,
    getParticipantNameFromProfile,
    getServiceFromServicePlan,
    formatLabelValue,
    formatValue,
    formatCurrencyValue,
    uploadFileToS3: vi.fn().mockResolvedValue({ $metadata: { httpStatusCode: 200 } }),
    getS3FileUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed/invoice.pdf'),
    saveInvoiceNumber: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe('generateParticipantTaxInvoicePdf', () => {
  beforeEach(async () => {
    vi.mocked(generate).mockReset();
    vi.mocked(generate).mockResolvedValue(new Uint8Array([37, 80, 68, 70])); // "%PDF"
    isoplus.setIntegrationMessage.mockReset().mockResolvedValue(undefined);
    isoplus.setGeneratedField.mockReset().mockResolvedValue(undefined);
    vi.mocked(logAuditTrail).mockReset();
    await seedBusinessCounter('ws_1');
  });

  const run = (overrides = {}) => {
    const business = overrides.business ?? makeBusiness();
    const res = overrides.res ?? makeRes();
    const deps = pdfDeps(overrides.deps);
    return generateParticipantTaxInvoicePdf({
      req: { body: { invoiceDate: '2026-03-15T00:00:00.000Z' }, ...overrides.req },
      res,
      workspaceId: 'ws_1',
      boardId: 'b_1',
      business,
      dbItems: overrides.dbItems ?? [deliveredRecord(), adjustmentRecord()],
      isLowCatBoard: overrides.isLowCatBoard ?? false,
      ...deps,
    }).then((returned) => ({ returned, res, business, deps }));
  };

  it('renders the participant-contribution template with the derived rows and totals', async () => {
    const { res, deps } = await run();

    const [{ template, inputs }] = vi.mocked(generate).mock.calls[0];
    const table = template.schemas[0].find((s) => s.type === 'table');
    expect(table.head[7]).toBe('Participant Contribution'); // participantTaxInvoiceAG.json
    expect(table.repeatHead).toBe(true); // enableRepeatHeadOnTables ran

    expect(inputs[0].orders).toEqual([
      ['04/03/2026', 'Assistance With Self-Care', 'Hour', '2.00', '$65.50', 'GST Free', '$131.00', '$25.75'],
      ['11/03/2026', 'Service - Late cancellation fee', ' ', '1.00', '$20.00', 'GST Free', '$20.00', '$20.00'],
    ]);
    expect(inputs[0].subtotal).toBe('$45.75');
    expect(inputs[0].total).toBe('$45.75');
    expect(inputs[0].totalGST).toBe('$0.00');
    expect(inputs[0].logo).toBe('data:image/png;base64,AAAA');
    expect(JSON.parse(inputs[0].clientDetails)).toEqual({
      'Billing Contact': 'Bob Citizen',
      'Billing Address': '12 Example St, Sydney NSW 2000',
    });
    expect(JSON.parse(inputs[0].invoiceDetails)).toEqual({ Date: '15/03/2026', 'Invoice Number': 'INV-1001' });
    expect(inputs[0].dueDate).toBe('29/03/2026'); // invoiceDate + 14 days
    expect(JSON.parse(inputs[0]['Bank Details'])).toEqual({
      'Account Name': 'Hillsgrade Care',
      'Bank Name': 'CBA',
      BSB: '062-000',
      'Account Number': '12345678',
      'invoice Number': 'INV-1001',
    });
    expect(JSON.parse(inputs[0].companyDetails)).toEqual({
      ABN: '12 345 678 901',
      'Street Address': '5 Depot Rd',
      Suburb: 'Parramatta',
      State: 'NSW',
      Postcode: '2150',
      Country: 'Australia',
    });

    expect(deps.bulkFetchReferenceItemsFromDB).toHaveBeenCalledWith('ws_1', 'b_1', ['pp_1', 'sp_1']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      message: 'Participant Tax Invoice generated successfully',
      invoiceNumber: 'INV-1001 (ISO+™)',
      fileUrl: 'https://s3.example.com/signed/invoice.pdf',
      itemCount: 2,
    });
  });

  it('uploads under the participant-scoped key and stamps every item', async () => {
    const { business, deps } = await run();

    expect(deps.uploadFileToS3).toHaveBeenCalledWith(
      Buffer.from(new Uint8Array([37, 80, 68, 70])),
      'output/ws_1/b_1/Participant-invoices/INV-1001-ISO+™-Jane-Citizen.pdf',
      false,
    );
    expect(deps.getS3FileUrl).toHaveBeenCalledWith(
      'output/ws_1/b_1/Participant-invoices/INV-1001-ISO+™-Jane-Citizen.pdf', 604800, false,
    );

    expect(isoplus.setGeneratedField.mock.calls).toEqual([
      ['ws_1', 'b_1', 'item_1', 'INV-1001 (ISO+™)'],
      ['ws_1', 'b_1', 'item_2', 'INV-1001 (ISO+™)'],
    ]);
    expect(deps.saveInvoiceNumber.mock.calls).toEqual([
      ['ws_1', 'b_1', 'item_1', 'INV-1001 (ISO+™)', 'PDF', 'https://s3.example.com/signed/invoice.pdf'],
      ['ws_1', 'b_1', 'item_2', 'INV-1001 (ISO+™)', 'PDF', 'https://s3.example.com/signed/invoice.pdf'],
    ]);

    // The stored counter moved, not a field on an in-memory copy.
    const stored = await Business.findOne({ workspaceId: 'ws_1' }).lean();
    expect(stored.documentNumbering.invoice.nextNumber).toBe(1002);
    expect(logAuditTrail).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws_1',
      action: 'Generate PDF Participant Tax Invoice',
      detail: 'Invoice generated successfully, invoice number: INV-1001 (ISO+™), participant: Jane Citizen, items: 2, fileUrl: https://s3.example.com/signed/invoice.pdf',
    }));
  });

  /**
   * The number used to be read off the passed-in business object at the top of
   * this function, and written back with `business.save()` at the bottom —
   * after rendering the PDF, uploading it to S3 and writing the number back to
   * every ISO+ row. Two generations overlapping anywhere across those awaits
   * both read the same counter and both put the same invoice number on a
   * different participant's invoice.
   *
   * The NDIS generator and the statement generator had already been fixed to
   * claim inside a single findOneAndUpdate; this path was the copy that had
   * not.
   */
  it('never puts one invoice number on two concurrent generations', async () => {
    const [first, second, third] = await Promise.all([run(), run(), run()]);

    const numbers = [first, second, third].map(({ res }) => res.body.invoiceNumber);
    expect(new Set(numbers).size).toBe(3);
    expect([...numbers].sort()).toEqual([
      'INV-1001 (ISO+™)', 'INV-1002 (ISO+™)', 'INV-1003 (ISO+™)',
    ]);

    const stored = await Business.findOne({ workspaceId: 'ws_1' }).lean();
    expect(stored.documentNumbering.invoice.nextNumber).toBe(1004);
  });

  // The number is claimed before the render, so a failed render leaves a gap in
  // the sequence rather than reissuing the number. Deliberate: a gap is
  // cosmetic, a duplicate invoice number is a billing bug a client sees.
  it('leaves a gap rather than reissuing a number after a failed render', async () => {
    vi.mocked(generate).mockRejectedValueOnce(new Error('pdfme exploded'));

    await expect(run()).rejects.toThrow(/pdfme exploded/);

    const { res } = await run();
    expect(res.body.invoiceNumber).toBe('INV-1002 (ISO+™)');
  });

  // A workspace with no Business row cannot number an invoice, and inventing
  // one would collide with whatever the real counter holds.
  it('refuses to generate for a workspace with no business profile', async () => {
    await Business.deleteMany({ workspaceId: 'ws_1' });

    await expect(run()).rejects.toThrow(/business/i);
  });

  // KAN-10: a participant tax invoice names the participant and their billing
  // address, and its key is a sequential invoice number, so it must land in the
  // non-public bucket behind an expiring presigned URL rather than at a
  // permanent guessable public-bucket address.
  it('uploads to the non-public bucket and signs the same bucket for seven days', async () => {
    const { deps } = await run();

    const [, uploadKey, uploadPublicRead] = deps.uploadFileToS3.mock.calls[0];
    const [urlKey, urlExpiry, urlPublicRead] = deps.getS3FileUrl.mock.calls[0];

    expect(uploadPublicRead).toBe(false);
    expect(urlPublicRead).toBe(false);
    expect(urlPublicRead).toBe(uploadPublicRead);
    expect(urlKey).toBe(uploadKey);
    expect(urlExpiry).toBe(604800);
  });

  it('keeps the output/<workspaceId>/<boardId>/Participant-invoices/<name> layout', async () => {
    const deps = pdfDeps();
    await seedBusinessCounter('55390');

    await generateParticipantTaxInvoicePdf({
      req: { body: { invoiceDate: '2026-03-15T00:00:00.000Z' } },
      res: makeRes(),
      workspaceId: '55390',
      boardId: 'jpjztrn14pJ',
      business: makeBusiness(),
      dbItems: [deliveredRecord()],
      isLowCatBoard: false,
      ...deps,
    });

    expect(deps.uploadFileToS3.mock.calls[0][1]).toBe(
      'output/55390/jpjztrn14pJ/Participant-invoices/INV-1001-ISO+™-Jane-Citizen.pdf',
    );
  });
  it('renders the low-cat template, totals the amounts instead of the contributions', async () => {
    const { res } = await run({ isLowCatBoard: true });

    const [{ template, inputs }] = vi.mocked(generate).mock.calls[0];
    const table = template.schemas[0].find((s) => s.type === 'table');
    expect(table.head[0]).toBe('Participant'); // taxInvoiceAG.json
    expect(inputs[0].orders[0][0]).toBe('Jane Citizen');
    expect(inputs[0].subtotal).toBe('$151.00'); // 131 + 20
    expect(inputs[0].total).toBe('$151.00');
    expect(res.statusCode).toBe(200);
  });

  it('answers 400 and marks every item when there is nothing to invoice', async () => {
    const { res, deps } = await run({ dbItems: [] });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'There is nothing to invoice!' });
    expect(generate).not.toHaveBeenCalled();
    expect(deps.uploadFileToS3).not.toHaveBeenCalled();
  });

  it('throws instead of reporting success when the S3 upload does not return 200', async () => {
    await expect(run({ deps: { uploadFileToS3: vi.fn().mockResolvedValue({ $metadata: { httpStatusCode: 500 } }) } }))
      .rejects.toThrow('Upload of PDF failed, please provide correct information.');
    expect(isoplus.setGeneratedField).not.toHaveBeenCalled();
  });

  it('honours an explicit due date rather than adding 14 days', async () => {
    await run({ req: { body: { invoiceDate: '2026-03-15T00:00:00.000Z', dueDate: '2026-04-30T00:00:00.000Z' } } });

    const [{ inputs }] = vi.mocked(generate).mock.calls[0];
    expect(inputs[0].dueDate).toBe('30/04/2026');
  });

  it('falls back to the participant name when the profile has no billing contact', async () => {
    const bareProfile = { itemId: 'pp_1', data: { 'Full Name/Preferred Name': 'Jane Citizen' } };

    await run({ deps: { bulkFetchReferenceItemsFromDB: vi.fn().mockResolvedValue(refMap(bareProfile, servicePlanItem())) } });

    const [{ inputs }] = vi.mocked(generate).mock.calls[0];
    expect(JSON.parse(inputs[0].clientDetails)).toEqual({
      'Billing Contact': 'Jane Citizen',
      'Billing Address': ' ',
    });
  });

  it('falls back to a single space when neither a billing contact nor a participant name exists', async () => {
    const items = [deliveredRecord()];
    delete items[0].data['Participant Profile'];

    await run({ dbItems: items, deps: { bulkFetchReferenceItemsFromDB: vi.fn().mockResolvedValue(refMap(servicePlanItem())) } });

    const [{ inputs }] = vi.mocked(generate).mock.calls[0];
    expect(JSON.parse(inputs[0].clientDetails)).toEqual({ 'Billing Contact': ' ', 'Billing Address': ' ' });
  });

  it('logs how many references were fetched', async () => {
    const { deps } = await run();

    expect(deps.info).toHaveBeenCalledWith(
      'Webhook-Service',
      'Bulk fetched reference items from DB',
      { participantProfiles: 1, servicePlans: 1, foundItems: 2 },
      expect.anything(),
    );
  });
});

describe('handleParticipantTaxInvoiceRoute', () => {
  beforeEach(async () => {
    await Board.deleteMany({});
    await Item.deleteMany({});
    isoplus.validateItemBelongsToTenant.mockReset().mockResolvedValue(undefined);
    isoplus.setIntegrationMessage.mockReset().mockResolvedValue(undefined);
    isoplus.setGeneratedField.mockReset().mockResolvedValue(undefined);
    vi.mocked(generate).mockReset().mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    vi.mocked(logAuditTrail).mockReset();
    // The stored counter the invoice number is claimed from. getValidatedBusiness
    // is stubbed below for the company details; the number is not read off it.
    await seedBusinessCounter('ws_1');
  });

  const routeDeps = (overrides = {}) => ({
    validateRequestParams: vi.fn(() => ({ workspaceId: 'ws_1', boardId: 'b_1' })),
    getValidatedBusiness: vi.fn().mockResolvedValue(makeBusiness()),
    ...pdfDeps(),
    ...overrides,
  });

  it('rejects a request with no items before touching the board or the database', async () => {
    const res = makeRes();
    const deps = routeDeps();

    await handleParticipantTaxInvoiceRoute({ params: {}, body: { items: [] } }, res, deps);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'No items provided for invoice generation.' });
    expect(isoplus.validateItemBelongsToTenant).not.toHaveBeenCalled();
  });

  it('accepts item objects, bare id strings and an itemIds array', async () => {
    await Item.create({ workspaceId: 'ws_1', boardId: 'b_1', folderId: 'f_1', itemId: 'item_1', data: deliveredRecord().data });

    for (const body of [
      { items: [{ id: 'item_1' }] },
      { items: ['item_1'] },
      { itemIds: ['item_1'] },
    ]) {
      const res = makeRes();
      await handleParticipantTaxInvoiceRoute({ params: {}, body }, res, routeDeps());
      expect(res.statusCode).toBe(200);
    }
  });

  it('picks the low-cat template when the board label says so', async () => {
    await Board.create({ boardId: 'b_1', name: 'SaH', label: 'Care Management - SaH - Low Cat' });
    await Item.create({ workspaceId: 'ws_1', boardId: 'b_1', folderId: 'f_1', itemId: 'item_1', data: deliveredRecord().data });

    await handleParticipantTaxInvoiceRoute({ params: {}, body: { items: [{ id: 'item_1' }] } }, makeRes(), routeDeps());

    const [{ template }] = vi.mocked(generate).mock.calls[0];
    expect(template.schemas[0].find((s) => s.type === 'table').head[0]).toBe('Participant');
  });

  it('turns a generation failure into a 500 with the error message', async () => {
    await Item.create({ workspaceId: 'ws_1', boardId: 'b_1', folderId: 'f_1', itemId: 'item_1', data: deliveredRecord().data });
    const res = makeRes();
    const deps = routeDeps({ getLogoData: vi.fn().mockRejectedValue(new Error('Logo download failed')) });

    await handleParticipantTaxInvoiceRoute({ params: {}, body: { items: [{ id: 'item_1' }] } }, res, deps);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: 'Logo download failed' });
    expect(deps.error).toHaveBeenCalledWith(
      'Webhook-Service',
      'Participant tax invoice PDF generation failed',
      expect.objectContaining({ errorMessage: 'Logo download failed' }),
      expect.anything(),
    );
  });

  it('lets a missing-item failure escape rather than turning it into a 500', async () => {
    // fetchValidatedDbItems runs before the try block, so its error propagates
    // to the router instead of being converted to a JSON 500 here.
    await expect(handleParticipantTaxInvoiceRoute(
      { params: {}, body: { items: [{ id: 'item_ghost' }] } }, makeRes(), routeDeps(),
    )).rejects.toThrow('Item item_ghost not found');
  });
});
