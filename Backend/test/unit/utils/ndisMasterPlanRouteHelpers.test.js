import { describe, it, expect, vi } from 'vitest';
import {
  buildMasterPlanAttributeFinder,
  buildMasterPlanResetValues,
  tryResetMasterPlanValues,
  buildNewMasterPlanSupportUpdate,
  buildNewMasterPlanProviderTravelUpdate,
  buildNewMasterPlanActivityTransportUpdate,
  buildNewMasterPlanLabourTravelUpdate,
  buildNewMasterPlanAllowancesUpdate,
  buildNewMasterPlanActiveUpdates,
  buildNewMasterPlanCancellationUpdate,
  buildNewMasterPlanFundStatusUpdate,
  handleMasterPlanNew,
  buildLegacyMasterPlanResetPayload,
  buildLegacyDirectSupportUpdates,
  buildLegacyActiveServiceAmounts,
  buildLegacyCancellationFeeUpdate,
  handleLegacyMasterPlan,
} from '../../../src/utils/ndisMasterPlanRouteHelpers.js';
import {
  NDIS_MASTERPLAN_ATTR,
  computeProviderTravelNonLabourAmount,
  computeActivityBaseTransportAmount,
  computeLabourTravelTimeAmount,
} from '../../../src/utils/ndisServiceRecords.js';
import { isShiftCancelled } from '../../../src/utils/ndisPricingRules.js';

/*
 * ndisMasterPlanRouteHelpers.js is the write-back half of the master plan
 * automation: given an ISO+ webhook body it computes the dollar values to PUT
 * back onto the Master Plan item. Getting one of these wrong writes a wrong
 * amount into the customer's board, which is then invoiced.
 *
 * Collaborators are injected, so the tests below pass the *production*
 * implementations copied out of src/routes/ndis.js (formatValue, toApiNumber,
 * isHourUnit) and the real compute* helpers, rather than stubs.
 *
 * `itemValuesWithAttributeId` mirrors GET /items/:id/values — an array of
 * `{ attribute: { id, name }, data }`. `itemsValues` mirrors the webhook body —
 * a flat object keyed by attribute name.
 */

// Copied verbatim from src/routes/ndis.js:51. Note it returns a STRING.
function formatValue(val) {
  const num = Number(val);
  if (!isNaN(num)) {
    const factor = Math.pow(10, 2);
    const result = Math.round(num * factor) / factor;
    return result.toFixed(2);
  }
  return val;
}

// Copied verbatim from src/routes/ndis.js:63.
function toApiNumber(val) {
  const num = Number(formatValue(val));
  return Number.isFinite(num) ? num : 0;
}

// Copied verbatim from src/routes/ndis.js:121.
function isHourUnit(unit) {
  if (!unit) return false;
  const u = unit.trim();
  return u === 'Hour(H)' || u === 'Hour' || u === 'H';
}

// Copied verbatim from src/routes/ndis.js:378.
function resolveConfigurationStatusLabelId(statusAttribute, desiredStatusText, fallbackColor) {
  const labels = statusAttribute?.attribute?.settings?.labels || [];
  if (!labels.length) return '';
  const normalizedDesiredText = String(desiredStatusText).toLowerCase();
  const exactMatch = labels.find((label) => (label.name || '').toLowerCase() === normalizedDesiredText);
  if (exactMatch?.id) return exactMatch.id;
  const includesMatch = labels.find((label) => (label.name || '').toLowerCase().includes(normalizedDesiredText));
  if (includesMatch?.id) return includesMatch.id;
  const colorMatch = labels.find((label) => label.color === fallbackColor);
  return colorMatch?.id || '';
}

const attrValue = (name, id) => ({ attribute: { id, name }, data: null });

/** Every attribute the master plan automation ever writes to, with a stable id. */
const ALL_ATTR_NAMES = [
  NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE,
  NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME,
  NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_NON_TIME,
  NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT,
  NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT,
  NDIS_MASTERPLAN_ATTR.CENTRE_CAPITAL_COSTS_AMOUNT,
  NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT,
  NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT,
  NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_AMOUNT,
  NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE,
];

const allAttributes = () => ALL_ATTR_NAMES.map((name, i) => attrValue(name, `id-${i}`));
const idOf = (name) => `id-${ALL_ATTR_NAMES.indexOf(name)}`;

describe('buildMasterPlanAttributeFinder', () => {
  // Breaks if the finder stops matching on the attribute name, which would make
  // every update fall back to null and silently write nothing.
  it('resolves an attribute id by name and tolerates malformed entries', () => {
    const find = buildMasterPlanAttributeFinder([
      { data: 1 },
      { attribute: null },
      attrValue('Support Value($)', 'attr-support'),
    ]);

    expect(find('Support Value($)')).toBe('attr-support');
    expect(find('Nope')).toBeUndefined();
  });
});

describe('buildMasterPlanResetValues', () => {
  // Breaks if a reset entry loses its zero: the reset pass is what clears last
  // run's amounts, so a missed field leaves a stale dollar value on the item.
  it('emits a zero for every attribute the board actually has', () => {
    const find = buildMasterPlanAttributeFinder(allAttributes());

    expect(buildMasterPlanResetValues(find, [
      NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE,
      'Not On This Board',
      NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE,
    ])).toEqual([
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE) },
    ]);

    expect(buildMasterPlanResetValues(find, [])).toEqual([]);
  });
});

describe('tryResetMasterPlanValues', () => {
  const args = (overrides = {}) => ({
    workspaceId: '55369',
    boardId: 'eNiJpH14PN3',
    itemId: 'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
    resetValues: [{ data: 0, attribute_id: 'a1' }],
    putMasterPlanItemValues: vi.fn().mockResolvedValue({ status: 200 }),
    warn: vi.fn(),
    extractIsoPlusErrorDetail: vi.fn(() => 'boom detail'),
    req: null,
    ...overrides,
  });

  it('PUTs the reset values with the workspace, board and item', async () => {
    const a = args();
    await tryResetMasterPlanValues(a);

    expect(a.putMasterPlanItemValues).toHaveBeenCalledWith(
      '55369', 'eNiJpH14PN3', 'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
      [{ data: 0, attribute_id: 'a1' }],
    );
  });

  // Breaks if the empty-list short circuit goes: PUTting an empty values array
  // is a wasted ISO+ call on every webhook.
  it('does not call ISO+ when there is nothing to reset', async () => {
    const a = args({ resetValues: [] });
    await tryResetMasterPlanValues(a);

    expect(a.putMasterPlanItemValues).not.toHaveBeenCalled();
  });

  // Breaks if the swallow goes: a failed reset must not abort the run, because
  // the calculated values that follow are the ones that matter.
  it('swallows a failed reset and logs the ISO+ detail', async () => {
    const err = Object.assign(new Error('nope'), { response: { status: 422 } });
    const a = args({ putMasterPlanItemValues: vi.fn().mockRejectedValue(err) });

    await expect(tryResetMasterPlanValues(a)).resolves.toBeUndefined();
    expect(a.extractIsoPlusErrorDetail).toHaveBeenCalledWith(err);
    expect(a.warn).toHaveBeenCalledWith(
      'Xero-Service',
      'Master plan reset values failed (continuing with calculated values)',
      expect.objectContaining({ status: 422, detail: 'boom detail', itemId: 'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce' }),
      null,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 2026-27 ("new") pricing amount builders
 * ------------------------------------------------------------------ */

const newCtx = (overrides = {}) => ({
  findAttrId: buildMasterPlanAttributeFinder(allAttributes()),
  NDIS_MASTERPLAN_ATTR,
  servicePlanValues: {},
  itemsValues: {},
  groupSize: 1,
  isHourUnit,
  formatValue,
  toApiNumber,
  computeProviderTravelNonLabourAmount,
  computeActivityBaseTransportAmount,
  computeLabourTravelTimeAmount,
  ...overrides,
});

describe('buildNewMasterPlanSupportUpdate', () => {
  // Breaks on a wrong group divisor or a lost 0.1h rounding: 80 * 2.5 / 1 = 200.
  it('prices actual hours at the agreed rate for an hour unit', () => {
    expect(buildNewMasterPlanSupportUpdate(newCtx({
      servicePlanValues: { supportUnit: 'Hour', supportUnitPrice: 80 },
      itemsValues: { 'Actual Shift Duration(Hr.)': '2.5' },
    }))).toEqual({ data: 200, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE) });
  });

  it('divides by the group size', () => {
    expect(buildNewMasterPlanSupportUpdate(newCtx({
      servicePlanValues: { supportUnit: 'Hour(H)', supportUnitPrice: 80 },
      itemsValues: { 'Actual Shift Duration(Hr.)': '2.5' },
      groupSize: 4,
    })).data).toBe(50);
  });

  // Breaks if the duration rounding goes: computeShiftQuantity fixes the hours
  // to one decimal before pricing, so 2.46h is billed as 2.5h.
  it('rounds the shift duration to one decimal before pricing', () => {
    expect(buildNewMasterPlanSupportUpdate(newCtx({
      servicePlanValues: { supportUnit: 'Hour', supportUnitPrice: 100 },
      itemsValues: { 'Actual Shift Duration(Hr.)': '2.46' },
    })).data).toBe(250);
  });

  // Breaks if the non-hour branch starts dividing by the group size — it does
  // not, which is a deliberate asymmetry with the hour branch.
  it('prices the stored quantity for a non-hour unit, ignoring the group size', () => {
    expect(buildNewMasterPlanSupportUpdate(newCtx({
      servicePlanValues: { supportUnit: 'Each', supportUnitPrice: 25 },
      itemsValues: { 'Quantity (Non-Time-Based Support)': '3' },
      groupSize: 4,
    }))).toEqual({ data: 75, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE) });
  });

  it('writes a zero rather than skipping when nothing is recorded', () => {
    expect(buildNewMasterPlanSupportUpdate(newCtx({
      servicePlanValues: { supportUnit: 'Hour' },
      itemsValues: { 'Actual Shift Duration(Hr.)': '0' },
    })).data).toBe(0);
    expect(buildNewMasterPlanSupportUpdate(newCtx({
      servicePlanValues: { supportUnit: 'Each' },
      itemsValues: {},
    })).data).toBe(0);
  });

  // Breaks if the missing-attribute guard goes: an update with an undefined
  // attribute_id makes ISO+ reject the entire PUT.
  it('returns null when the board has no Support Value column', () => {
    expect(buildNewMasterPlanSupportUpdate(newCtx({
      findAttrId: () => undefined,
      servicePlanValues: { supportUnit: 'Hour', supportUnitPrice: 80 },
      itemsValues: { 'Actual Shift Duration(Hr.)': '2' },
    }))).toBeNull();
  });
});

describe('buildNewMasterPlan travel / transport / labour updates', () => {
  // Breaks on the price*mileage + other formula: 0.80 * 20 + 2.60 = 18.60.
  it('computes the provider travel amount', () => {
    expect(buildNewMasterPlanProviderTravelUpdate(newCtx({
      servicePlanValues: { nonLabourTravelUnitPrice: 0.8 },
      itemsValues: {
        [NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE]: '20',
        [NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_OTHER_COSTS]: '2.60',
      },
    }))).toEqual({ data: 18.6, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT) });
  });

  // Breaks if the "($)" spelling is dropped from the other-costs lookup, which
  // is the column name newer boards use.
  it('prefers the "($)" spelling of the other-costs column', () => {
    expect(buildNewMasterPlanProviderTravelUpdate(newCtx({
      servicePlanValues: { nonLabourTravelUnitPrice: 0.8 },
      itemsValues: {
        [NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE]: '20',
        'Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied ($)': '5',
        [NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_OTHER_COSTS]: '2.60',
      },
    })).data).toBe(21);
  });

  // Breaks if the price gate goes: with no agreed rate there is no travel line
  // at all, and the field must be left at its reset zero.
  it('returns null without an agreed non-labour travel rate or column', () => {
    expect(buildNewMasterPlanProviderTravelUpdate(newCtx({
      servicePlanValues: {},
      itemsValues: { [NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE]: '20' },
    }))).toBeNull();
    expect(buildNewMasterPlanProviderTravelUpdate(newCtx({
      findAttrId: () => undefined,
      servicePlanValues: { nonLabourTravelUnitPrice: 0.8 },
    }))).toBeNull();
  });

  it('computes the activity based transport amount', () => {
    expect(buildNewMasterPlanActivityTransportUpdate(newCtx({
      servicePlanValues: { activityBasedTransportUnitPrice: 1.2 },
      itemsValues: {
        [NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_MILEAGE]: '15',
        [NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_OTHER_COSTS]: '1.50',
      },
    }))).toEqual({ data: 19.5, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT) });

    expect(buildNewMasterPlanActivityTransportUpdate(newCtx({ servicePlanValues: {} }))).toBeNull();
  });

  // Breaks on the minutes->hours conversion: 65 * (45 / 60) = 48.75.
  it('converts labour travel minutes to hours before pricing', () => {
    expect(buildNewMasterPlanLabourTravelUpdate(newCtx({
      servicePlanValues: { labourTravelTimeUnitPrice: 65 },
      itemsValues: { [NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_MIN]: '45' },
    }))).toEqual({ data: 48.75, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT) });

    expect(buildNewMasterPlanLabourTravelUpdate(newCtx({
      servicePlanValues: { labourTravelTimeUnitPrice: 65 },
      itemsValues: {},
    })).data).toBe(0);

    expect(buildNewMasterPlanLabourTravelUpdate(newCtx({ servicePlanValues: {} }))).toBeNull();
  });
});

describe('buildNewMasterPlanAllowancesUpdate', () => {
  // Breaks if the gate and the value stop reading the same column — the used
  // allowance amount is both the trigger and the amount written.
  it('echoes the used allowance amount', () => {
    expect(buildNewMasterPlanAllowancesUpdate(newCtx({
      itemsValues: { [NDIS_MASTERPLAN_ATTR.USED_ALLOWANCE_AMOUNT]: '35.5' },
    }))).toEqual({ data: 35.5, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT) });
  });

  it('returns null when no allowance was used or the column is absent', () => {
    expect(buildNewMasterPlanAllowancesUpdate(newCtx({ itemsValues: {} }))).toBeNull();
    expect(buildNewMasterPlanAllowancesUpdate(newCtx({
      itemsValues: { [NDIS_MASTERPLAN_ATTR.USED_ALLOWANCE_AMOUNT]: 0 },
    }))).toBeNull();
    expect(buildNewMasterPlanAllowancesUpdate(newCtx({
      findAttrId: () => undefined,
      itemsValues: { [NDIS_MASTERPLAN_ATTR.USED_ALLOWANCE_AMOUNT]: '35' },
    }))).toBeNull();
  });

  // Characterizing a truthiness quirk: the gate tests the raw value, so the
  // STRING '0' (which is what ISO+ posts for a numeric column) passes it and
  // writes an explicit 0, while a numeric 0 returns null and leaves the reset
  // zero in place. Both end at 0 here, but the gate is not value-based.
  it('treats the string "0" as a used allowance and writes an explicit zero', () => {
    expect(buildNewMasterPlanAllowancesUpdate(newCtx({
      itemsValues: { [NDIS_MASTERPLAN_ATTR.USED_ALLOWANCE_AMOUNT]: '0' },
    }))).toEqual({ data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT) });
  });
});

describe('buildNewMasterPlanActiveUpdates', () => {
  // Breaks if a builder is dropped or reordered — this array is the PUT body.
  it('collects the five amount updates in order, dropping the inapplicable', () => {
    const ctx = newCtx({
      servicePlanValues: {
        supportUnit: 'Hour',
        supportUnitPrice: 80,
        nonLabourTravelUnitPrice: 0.8,
        labourTravelTimeUnitPrice: 65,
      },
      itemsValues: {
        'Actual Shift Duration(Hr.)': '2',
        [NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE]: '10',
        [NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_MIN]: '30',
        [NDIS_MASTERPLAN_ATTR.USED_ALLOWANCE_AMOUNT]: '35',
      },
    });

    expect(buildNewMasterPlanActiveUpdates(ctx)).toEqual([
      { data: 160, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE) },
      { data: 8, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT) },
      { data: 32.5, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT) },
      { data: 35, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT) },
    ]);
  });
});

describe('buildNewMasterPlanCancellationUpdate', () => {
  // Breaks on the scheduled-hours * cancellation-rate product: 3 * 50 = 150.
  it('bills the scheduled hours at the agreed cancellation rate', () => {
    expect(buildNewMasterPlanCancellationUpdate(newCtx({
      servicePlanValues: { cancellationUnitPrice: '50' },
      itemsValues: { 'Scheduled Shift Duration(Hr.)': '3' },
    }))).toEqual({ data: 150, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE) });
  });

  // Breaks if the zero case starts returning null: writing an explicit 0 is how
  // a previously-charged cancellation fee gets cleared.
  it('writes an explicit zero when there is no rate or no scheduled time', () => {
    expect(buildNewMasterPlanCancellationUpdate(newCtx({
      servicePlanValues: {},
      itemsValues: { 'Scheduled Shift Duration(Hr.)': '3' },
    })).data).toBe(0);
    expect(buildNewMasterPlanCancellationUpdate(newCtx({
      servicePlanValues: { cancellationUnitPrice: '50' },
      itemsValues: { 'Scheduled Shift Duration(Hr.)': '0' },
    })).data).toBe(0);
  });

  it('returns null when the board has no Cancellation Fee column', () => {
    expect(buildNewMasterPlanCancellationUpdate(newCtx({ findAttrId: () => undefined }))).toBeNull();
  });
});

describe('buildNewMasterPlanFundStatusUpdate', () => {
  const fundStatusAttr = {
    attribute: {
      id: 'attr-fund',
      name: 'Funding Budget Status',
      settings: { labels: [{ id: 'label-ok', name: 'Within Budget', color: '#388903' }] },
    },
    data: null,
  };

  // Breaks if the status stops being wrapped in an array: ISO+ label columns
  // take an array of label ids, not the label text.
  it('writes the resolved label id as a single-element array', () => {
    expect(buildNewMasterPlanFundStatusUpdate({
      fundValues: { fundingBudgetStatus: 'Within Budget' },
      itemValuesWithAttributeId: [fundStatusAttr],
      resolveConfigurationStatusLabelId,
    })).toEqual({ data: ['label-ok'], attribute_id: 'attr-fund' });
  });

  it('returns null without fund values, without the column, or without a label', () => {
    expect(buildNewMasterPlanFundStatusUpdate({
      fundValues: null,
      itemValuesWithAttributeId: [fundStatusAttr],
      resolveConfigurationStatusLabelId,
    })).toBeNull();

    expect(buildNewMasterPlanFundStatusUpdate({
      fundValues: { fundingBudgetStatus: 'Within Budget' },
      itemValuesWithAttributeId: [],
      resolveConfigurationStatusLabelId,
    })).toBeNull();

    expect(buildNewMasterPlanFundStatusUpdate({
      fundValues: { fundingBudgetStatus: 'Something Else' },
      itemValuesWithAttributeId: [{ attribute: { id: 'attr-fund', name: 'Funding Budget Status', settings: { labels: [] } } }],
      resolveConfigurationStatusLabelId,
    })).toBeNull();
  });

  // Breaks if the green fallback colour changes — it is what selects the label
  // when the configured label name does not match the status text.
  it('falls back to the green label when the name does not match', () => {
    expect(buildNewMasterPlanFundStatusUpdate({
      fundValues: { fundingBudgetStatus: 'OK' },
      itemValuesWithAttributeId: [{
        attribute: {
          id: 'attr-fund',
          name: 'Funding Budget Status',
          settings: { labels: [{ id: 'label-green', name: 'Fully Funded', color: '#388903' }] },
        },
      }],
      resolveConfigurationStatusLabelId,
    })).toEqual({ data: ['label-green'], attribute_id: 'attr-fund' });
  });
});

/* ------------------------------------------------------------------ *
 * handleMasterPlanNew
 * ------------------------------------------------------------------ */

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

const WORKSPACE = '55369';
const BOARD = 'eNiJpH14PN3';
const ITEM = 'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce';

const makeReq = (values = {}, id = ITEM) => ({
  params: { workspaceId: WORKSPACE, boardId: BOARD },
  body: { items: [{ id, values }] },
});

function newDeps(overrides = {}) {
  return {
    getNDISMasterPlanNewPricingReferencedItems: vi.fn().mockResolvedValue([
      { supportUnit: 'Hour', supportUnitPrice: 80 },
      null,
      null,
    ]),
    getItemValues: vi.fn().mockResolvedValue({ values: allAttributes() }),
    setIntegrationMessage: vi.fn().mockResolvedValue(undefined),
    putMasterPlanItemValues: vi.fn().mockResolvedValue({ status: 200 }),
    isShiftCancelled,
    isHourUnit,
    formatValue,
    toApiNumber,
    NDIS_MASTERPLAN_ATTR,
    computeProviderTravelNonLabourAmount,
    computeActivityBaseTransportAmount,
    computeLabourTravelTimeAmount,
    resolveConfigurationStatusLabelId,
    extractIsoPlusErrorDetail: vi.fn((err) => err?.response?.data?.message || err?.message || 'Unknown error'),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe('handleMasterPlanNew', () => {
  // Breaks if a failure ever stops answering 200: ISO+ retries non-2xx webhooks,
  // so every outcome here is a 200 with an error body.
  it('rejects a payload with no item id, still with status 200', async () => {
    const res = makeRes();
    await handleMasterPlanNew({ params: { workspaceId: WORKSPACE, boardId: BOARD }, body: {} }, res, newDeps());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ error: 'Invalid payload', message: 'Missing item id' });
  });

  it('reports a missing service plan and writes it to the integration message', async () => {
    const res = makeRes();
    const deps = newDeps({
      getNDISMasterPlanNewPricingReferencedItems: vi.fn().mockResolvedValue([null, null, null]),
    });
    await handleMasterPlanNew(makeReq(), res, deps);

    expect(res.body).toEqual({ error: 'Service Plan Item not found' });
    expect(deps.setIntegrationMessage).toHaveBeenCalledWith(WORKSPACE, BOARD, ITEM, 'Service Plan Item not found');
    expect(deps.putMasterPlanItemValues).not.toHaveBeenCalled();
  });

  // Breaks if the reset pass is dropped or reordered after the calculation, or
  // if the calculated PUT stops carrying the derived amount.
  it('resets the amount columns first, then PUTs the calculated values', async () => {
    const res = makeRes();
    const deps = newDeps();
    await handleMasterPlanNew(makeReq({ 'Actual Shift Duration(Hr.)': '2' }), res, deps);

    expect(deps.putMasterPlanItemValues).toHaveBeenCalledTimes(2);

    const [resetCall, updateCall] = deps.putMasterPlanItemValues.mock.calls;
    expect(resetCall[3]).toEqual([
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE) },
    ]);
    expect(updateCall[3]).toEqual([
      { data: 160, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE) },
    ]);
    expect(res.body).toEqual({ message: 'Master plan processed' });
    expect(deps.setIntegrationMessage).toHaveBeenLastCalledWith(
      WORKSPACE, BOARD, ITEM, 'Master plan processed successfully',
    );
  });

  // Breaks if a cancelled shift starts writing service amounts, which would
  // charge for a shift that never happened.
  it('writes only the cancellation fee for a cancelled shift', async () => {
    const res = makeRes();
    const deps = newDeps({
      getNDISMasterPlanNewPricingReferencedItems: vi.fn().mockResolvedValue([
        { supportUnit: 'Hour', supportUnitPrice: 80, cancellationUnitPrice: 50 },
        null,
        null,
      ]),
    });
    await handleMasterPlanNew(makeReq({
      'Job Status': 'Cancelled',
      'Actual Shift Duration(Hr.)': '2',
      'Scheduled Shift Duration(Hr.)': '3',
    }), res, deps);

    expect(deps.putMasterPlanItemValues.mock.calls[1][3]).toEqual([
      { data: 150, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE) },
    ]);
  });

  it('appends the funding budget status when fund values are present', async () => {
    const res = makeRes();
    const fundAttr = {
      attribute: {
        id: 'attr-fund',
        name: 'Funding Budget Status',
        settings: { labels: [{ id: 'label-ok', name: 'Within Budget', color: '#388903' }] },
      },
    };
    const deps = newDeps({
      getItemValues: vi.fn().mockResolvedValue({ values: [...allAttributes(), fundAttr] }),
      getNDISMasterPlanNewPricingReferencedItems: vi.fn().mockResolvedValue([
        { supportUnit: 'Hour', supportUnitPrice: 80 },
        null,
        { fundingBudgetStatus: 'Within Budget' },
      ]),
    });
    await handleMasterPlanNew(makeReq({ 'Actual Shift Duration(Hr.)': '2' }), res, deps);

    expect(deps.putMasterPlanItemValues.mock.calls[1][3]).toEqual([
      { data: 160, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE) },
      { data: ['label-ok'], attribute_id: 'attr-fund' },
    ]);
  });

  // Breaks if an empty update list starts being PUT anyway.
  it('short circuits when there is nothing to update', async () => {
    const res = makeRes();
    const deps = newDeps({ getItemValues: vi.fn().mockResolvedValue({ values: [] }) });
    await handleMasterPlanNew(makeReq(), res, deps);

    expect(res.body).toEqual({ message: 'No master plan values to update' });
    expect(deps.putMasterPlanItemValues).not.toHaveBeenCalled();
  });

  it('reports a non-200 response from ISO+ as a failure', async () => {
    const res = makeRes();
    const deps = newDeps({
      putMasterPlanItemValues: vi.fn()
        .mockResolvedValueOnce({ status: 200 })
        .mockResolvedValueOnce({ status: 500 }),
    });
    await handleMasterPlanNew(makeReq({ 'Actual Shift Duration(Hr.)': '2' }), res, deps);

    expect(res.body).toEqual({ error: 'Failed to update master plan' });
    expect(deps.setIntegrationMessage).toHaveBeenLastCalledWith(
      WORKSPACE, BOARD, ITEM, 'Failed to update master plan',
    );
  });

  // Breaks if the catch-all is removed: an unhandled rejection here becomes a
  // 500 that ISO+ retries forever.
  it('catches a thrown error, logs it and surfaces the ISO+ detail', async () => {
    const res = makeRes();
    const err = Object.assign(new Error('socket hang up'), {
      response: { status: 502, data: { message: 'Bad gateway' } },
    });
    const deps = newDeps({ getItemValues: vi.fn().mockRejectedValue(err) });
    await handleMasterPlanNew(makeReq(), res, deps);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ error: 'Master plan failed', message: 'Bad gateway' });
    expect(deps.error).toHaveBeenCalledWith(
      'Xero-Service',
      'Master plan new pricing automation failed',
      expect.objectContaining({ status: 502, detail: 'Bad gateway' }),
      expect.anything(),
    );
    expect(deps.setIntegrationMessage).toHaveBeenLastCalledWith(
      WORKSPACE, BOARD, ITEM, 'Master plan update failed: Bad gateway',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Legacy pricing builders
 * ------------------------------------------------------------------ */

describe('buildLegacyMasterPlanResetPayload', () => {
  // Breaks if a reset column is added, removed or reordered — this is the exact
  // list of legacy amount columns cleared before recalculation.
  it('emits a zero for each of the nine legacy amount columns present', () => {
    expect(buildLegacyMasterPlanResetPayload(allAttributes())).toEqual([
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_NON_TIME) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CENTRE_CAPITAL_COSTS_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_AMOUNT) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE) },
    ]);
  });

  it('drops columns the board does not have', () => {
    expect(buildLegacyMasterPlanResetPayload([
      attrValue(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE, 'a1'),
    ])).toEqual([{ data: 0, attribute_id: 'a1' }]);
    expect(buildLegacyMasterPlanResetPayload([])).toEqual([]);
  });

  // Characterizing a latent crash: the legacy finder reads `v.attribute.name`
  // with no optional chaining, unlike buildMasterPlanAttributeFinder, so a value
  // entry without an `attribute` throws rather than being skipped.
  it('throws on a value entry that has no attribute object', () => {
    expect(() => buildLegacyMasterPlanResetPayload([{ data: 1 }]))
      .toThrow(TypeError);
  });
});

describe('buildLegacyDirectSupportUpdates', () => {
  const itemValues = allAttributes();
  const TIME_ID = idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME);
  const NON_TIME_ID = idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_NON_TIME);

  // Breaks on a wrong group divisor, or if the opposite column stops being
  // zeroed — leaving both populated double-bills the shift.
  it('bills hours and zeroes the non-time column for an Hour(H) plan', () => {
    expect(buildLegacyDirectSupportUpdates({
      servicePlanValues: { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70 },
      itemsValues: { 'Actual Shift Duration(Hr.)': '2.5' },
      groupSize: 2,
      itemValuesWithAttributeId: itemValues,
      formatValue,
    })).toEqual([
      { data: '87.50', attribute_id: TIME_ID },
      { data: 0, attribute_id: NON_TIME_ID },
    ]);
  });

  // Breaks if the unit test loosens: only the exact string 'Hour(H)' takes the
  // hourly branch here, unlike the 2026-27 helper's isHourUnit.
  it('takes the non-time branch for any other unit, including "Hour"', () => {
    expect(buildLegacyDirectSupportUpdates({
      servicePlanValues: { directSupportUnit: 'Hour', directSupportUnitPrice: 70 },
      itemsValues: { 'Actual Shift Duration(Hr.)': '2.5', 'Quantity (Direct Support - Non Time Based Support)': '3' },
      groupSize: 1,
      itemValuesWithAttributeId: itemValues,
      formatValue,
    })).toEqual([
      { data: '210.00', attribute_id: NON_TIME_ID },
      { data: 0, attribute_id: TIME_ID },
    ]);
  });

  it('writes zeroes when nothing is recorded', () => {
    expect(buildLegacyDirectSupportUpdates({
      servicePlanValues: { directSupportUnit: 'Each(E)', directSupportUnitPrice: 25 },
      itemsValues: {},
      groupSize: 1,
      itemValuesWithAttributeId: itemValues,
      formatValue,
    })).toEqual([
      { data: '0.00', attribute_id: NON_TIME_ID },
      { data: 0, attribute_id: TIME_ID },
    ]);
  });

  // Breaks if the both-columns guard goes: writing one half of the pair leaves
  // the other holding a stale amount.
  it('emits nothing unless the board has both direct support columns', () => {
    expect(buildLegacyDirectSupportUpdates({
      servicePlanValues: { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70 },
      itemsValues: { 'Actual Shift Duration(Hr.)': '2' },
      groupSize: 1,
      itemValuesWithAttributeId: [attrValue(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME, 'a1')],
      formatValue,
    })).toEqual([]);
  });
});

describe('buildLegacyActiveServiceAmounts', () => {
  const legacyArgs = (servicePlanValues, itemsValues) => ({
    servicePlanValues,
    itemsValues,
    itemValuesWithAttributeId: allAttributes(),
    formatValue,
    computeActivityBaseTransportAmount,
    NDIS_MASTERPLAN_ATTR,
  });

  // Breaks if a builder is dropped or reordered, or if centre capital stops
  // emitting its explicit zero.
  it('emits direct support plus the applicable optional amounts, in order', () => {
    const updates = buildLegacyActiveServiceAmounts(legacyArgs(
      {
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70,
        nonLabourTravelUnitPrice: 0.8,
        activityBasedTransportUnitPrice: 1.2,
        centreCapitalCostsUnitPrice: 12,
        labourTravelTimeUnitPrice: 65,
        nonFaceToFaceSupportUnitPrice: 60,
      },
      {
        'Group Size': '1',
        'Actual Shift Duration(Hr.)': '2.5',
        'Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a vehicle is used.': '20',
        'Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied.': '2.60',
        [NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_MILEAGE]: '15',
        [NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_MIN]: '45',
        'Used Allowance Amount($) as per the Service Plan': '35',
        'Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)': '1.5',
      },
    ));

    expect(updates).toEqual([
      { data: '175.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_NON_TIME) },
      // Legacy multiplies the RATE by (mileage + other costs): 0.8 * 22.6 = 18.08.
      { data: '18.08', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT) },
      // Activity transport uses the shared helper: 1.2 * 15 + 0 = 18.00.
      { data: '18.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT) },
      { data: '30.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CENTRE_CAPITAL_COSTS_AMOUNT) },
      // Legacy multiplies the rate by MINUTES, with no /60 conversion.
      { data: '2925.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT) },
      { data: '35.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT) },
      { data: '90.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_AMOUNT) },
    ]);
  });

  // Breaks if centre capital stops writing its explicit zero: it is the only
  // optional component that always writes, so a stale amount cannot survive.
  it('always writes a centre capital amount, zero when there is no rate', () => {
    const updates = buildLegacyActiveServiceAmounts(legacyArgs(
      { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70 },
      { 'Actual Shift Duration(Hr.)': '2.5' },
    ));

    expect(updates).toEqual([
      { data: '175.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_NON_TIME) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CENTRE_CAPITAL_COSTS_AMOUNT) },
    ]);
  });

  // Breaks if the group size stops being read out of the webhook body here.
  it('reads the group size from the webhook body, defaulting to 1', () => {
    const withGroup = buildLegacyActiveServiceAmounts(legacyArgs(
      { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70 },
      { 'Actual Shift Duration(Hr.)': '2', 'Group Size': '2' },
    ));
    expect(withGroup[0].data).toBe('70.00');

    const withoutGroup = buildLegacyActiveServiceAmounts(legacyArgs(
      { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70 },
      { 'Actual Shift Duration(Hr.)': '2' },
    ));
    expect(withoutGroup[0].data).toBe('140.00');
  });
});

describe('buildLegacyCancellationFeeUpdate', () => {
  const cancArgs = (servicePlanValues, itemsValues, billableToClient = '90') => ({
    servicePlanValues,
    cancellationTypeValues: billableToClient === null ? null : { billableToClient },
    itemsValues,
    itemValuesWithAttributeId: allAttributes(),
    formatValue,
  });

  // Breaks on a wrong billable percentage or a lost group divisor:
  // 70 / 1 * 90% = 63.00, and 3 scheduled hours * 63.00 = 189.00.
  it('bills scheduled hours at the discounted hourly rate', () => {
    expect(buildLegacyCancellationFeeUpdate(cancArgs(
      {
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70,
        directSupportShortNoticeCancellations: 'Y',
      },
      { 'Scheduled Shift Duration(Hr.)': '3' },
    ))).toEqual({ data: '189.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE) });
  });

  it('divides the hourly cancellation rate by the group size', () => {
    expect(buildLegacyCancellationFeeUpdate(cancArgs(
      {
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70,
        directSupportShortNoticeCancellations: 'Y',
      },
      { 'Scheduled Shift Duration(Hr.)': '3', 'Group Size': '2' },
    )).data).toBe('94.50');
  });

  // Breaks if the non-hour branch stops using the stored quantity, or starts
  // dividing by the group size.
  it('bills the stored quantity at the undivided rate for a non-hour plan', () => {
    expect(buildLegacyCancellationFeeUpdate(cancArgs(
      {
        directSupportUnit: 'Each(E)',
        directSupportUnitPrice: 25,
        directSupportShortNoticeCancellations: 'Y',
      },
      {
        'Scheduled Shift Duration(Hr.)': '3',
        'Group Size': '2',
        'Quantity (Direct Support - Non Time Based Support)': '4',
      },
      '50',
    )).data).toBe('50.00');
  });

  // Breaks if a short-notice flag stops gating its component: each of the four
  // components is charged only when the service plan says it may be.
  it('adds each opted-in travel component at scheduled-hours * discounted rate', () => {
    expect(buildLegacyCancellationFeeUpdate(cancArgs(
      {
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70,
        directSupportShortNoticeCancellations: 'Y',
        nonLabourTravelUnitPrice: 0.8,
        providerTravelShortNoticeCancellations: 'Y',
        activityBasedTransportUnitPrice: 1.2,
        activityBasedTransportShortNoticeCancellations: 'N',
        centreCapitalCostsUnitPrice: 12,
        centreCapitalCostsShortNoticeCancellations: 'Y',
      },
      { 'Scheduled Shift Duration(Hr.)': '3' },
    // 189.00 + (0.72 * 3 = 2.16) + (10.80 * 3 = 32.40) = 223.56
    )).data).toBe('223.56');
  });

  it('charges nothing when no component opted in or the type is missing', () => {
    expect(buildLegacyCancellationFeeUpdate(cancArgs(
      { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70, directSupportShortNoticeCancellations: 'N' },
      { 'Scheduled Shift Duration(Hr.)': '3' },
    )).data).toBe('0.00');

    expect(buildLegacyCancellationFeeUpdate(cancArgs(
      { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70, directSupportShortNoticeCancellations: 'Y' },
      { 'Scheduled Shift Duration(Hr.)': '3' },
      null,
    )).data).toBe('0.00');
  });

  it('returns null when the board has no Cancellation Fee column', () => {
    expect(buildLegacyCancellationFeeUpdate({
      servicePlanValues: {},
      cancellationTypeValues: null,
      itemsValues: {},
      itemValuesWithAttributeId: [attrValue('Something Else', 'a1')],
      formatValue,
    })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * handleLegacyMasterPlan
 * ------------------------------------------------------------------ */

function legacyDeps(overrides = {}) {
  return {
    getNDISMasterPlanReferencedItems: vi.fn().mockResolvedValue([
      { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70 },
      null,
      null,
    ]),
    getItemValues: vi.fn().mockResolvedValue({ values: allAttributes() }),
    setIntegrationMessage: vi.fn().mockResolvedValue(undefined),
    putMasterPlanItemValues: vi.fn().mockResolvedValue({ status: 200 }),
    isShiftCancelled,
    formatValue,
    computeActivityBaseTransportAmount,
    NDIS_MASTERPLAN_ATTR,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe('handleLegacyMasterPlan', () => {
  it('reports a missing service plan without touching ISO+ values', async () => {
    const res = makeRes();
    const deps = legacyDeps({
      getNDISMasterPlanReferencedItems: vi.fn().mockResolvedValue([null, null, null]),
    });
    await handleLegacyMasterPlan(makeReq(), res, deps);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ error: 'Service Plan Item not found' });
    expect(deps.putMasterPlanItemValues).not.toHaveBeenCalled();
  });

  it('resets then writes the calculated legacy amounts', async () => {
    const res = makeRes();
    const deps = legacyDeps();
    await handleLegacyMasterPlan(makeReq({ 'Actual Shift Duration(Hr.)': '2.5' }), res, deps);

    expect(deps.putMasterPlanItemValues).toHaveBeenCalledTimes(2);
    expect(deps.putMasterPlanItemValues.mock.calls[0][3]).toHaveLength(9);
    expect(deps.putMasterPlanItemValues.mock.calls[1][3]).toEqual([
      { data: '175.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_NON_TIME) },
      { data: 0, attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CENTRE_CAPITAL_COSTS_AMOUNT) },
    ]);
    expect(res.body).toEqual({ message: 'Master plan processed' });
  });

  // Breaks if the cancellation-type requirement is dropped: without a billable
  // percentage the fee would silently compute to zero.
  it('refuses a cancelled shift with no cancellation type', async () => {
    const res = makeRes();
    const deps = legacyDeps();
    await handleLegacyMasterPlan(makeReq({ 'Job Status': 'Cancelled' }), res, deps);

    expect(res.body).toEqual({ error: 'A cancellation type is required.' });
    expect(deps.setIntegrationMessage).toHaveBeenLastCalledWith(
      WORKSPACE, BOARD, ITEM, 'A cancellation type is required.',
    );
    // The reset PUT has already run; the calculated PUT has not.
    expect(deps.putMasterPlanItemValues).toHaveBeenCalledTimes(1);
  });

  it('writes only the cancellation fee for a cancelled shift', async () => {
    const res = makeRes();
    const deps = legacyDeps({
      getNDISMasterPlanReferencedItems: vi.fn().mockResolvedValue([
        {
          directSupportUnit: 'Hour(H)',
          directSupportUnitPrice: 70,
          directSupportShortNoticeCancellations: 'Y',
        },
        { billableToClient: '90' },
        null,
      ]),
    });
    await handleLegacyMasterPlan(makeReq({
      'Shift Status': 'Cancelled',
      'Actual Shift Duration(Hr.)': '2.5',
      'Scheduled Shift Duration(Hr.)': '3',
    }), res, deps);

    expect(deps.putMasterPlanItemValues.mock.calls[1][3]).toEqual([
      { data: '189.00', attribute_id: idOf(NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE) },
    ]);
  });

  // Breaks if the legacy fund status starts being wrapped like the 2026-27 one:
  // legacy boards store the status as plain text, not a label id array.
  it('appends the funding budget status as raw text', async () => {
    const res = makeRes();
    const deps = legacyDeps({
      getItemValues: vi.fn().mockResolvedValue({
        values: [...allAttributes(), attrValue('Funding Budget Status', 'attr-fund')],
      }),
      getNDISMasterPlanReferencedItems: vi.fn().mockResolvedValue([
        { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70 },
        null,
        { fundingBudgetStatus: 'Within Budget' },
      ]),
    });
    await handleLegacyMasterPlan(makeReq({ 'Actual Shift Duration(Hr.)': '2' }), res, deps);

    expect(deps.putMasterPlanItemValues.mock.calls[1][3].at(-1))
      .toEqual({ data: 'Within Budget', attribute_id: 'attr-fund' });
  });

  it('reports a non-200 response from ISO+ as a failure', async () => {
    const res = makeRes();
    const deps = legacyDeps({
      putMasterPlanItemValues: vi.fn()
        .mockResolvedValueOnce({ status: 200 })
        .mockResolvedValueOnce({ status: 503 }),
    });
    await handleLegacyMasterPlan(makeReq({ 'Actual Shift Duration(Hr.)': '2' }), res, deps);

    expect(res.body).toEqual({ error: 'Failed to update master plan' });
    expect(deps.warn).toHaveBeenCalledWith(
      'Xero-Service', 'Failed to update master plan', expect.any(Object), expect.anything(),
    );
  });

  // Breaks if path-segment validation is dropped from the route helper — these
  // values are interpolated into the ISO+ URL.
  it('rejects a path-traversing workspace id', async () => {
    await expect(handleLegacyMasterPlan(
      { params: { workspaceId: '../admin', boardId: BOARD }, body: { items: [{ id: ITEM, values: {} }] } },
      makeRes(),
      legacyDeps(),
    )).rejects.toThrow(/Invalid workspaceId/);
  });

  // Characterizing the difference from handleMasterPlanNew: the legacy handler
  // has no try/catch, so an ISO+ failure propagates to the route.
  it('lets an ISO+ error propagate rather than answering 200', async () => {
    const deps = legacyDeps({ getItemValues: vi.fn().mockRejectedValue(new Error('socket hang up')) });

    await expect(handleLegacyMasterPlan(makeReq(), makeRes(), deps))
      .rejects.toThrow('socket hang up');
  });
});
