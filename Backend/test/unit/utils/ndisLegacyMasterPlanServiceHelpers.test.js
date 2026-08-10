import { describe, it, expect } from 'vitest';
import { buildLegacyNdisMasterPlanServiceRows } from '../../../src/utils/ndisLegacyMasterPlanServiceHelpers.js';

/*
 * buildLegacyNdisMasterPlanServiceRows() expands one Master Plan shift into the
 * invoice/claim rows under the pre-2026-27 ("legacy") NDIS pricing rule: Direct
 * Support split into time/non-time lines, Centre Capital Costs, Non-Face-to-Face,
 * and a cancellation that is recomputed per component from the Billable to
 * Client % on the cancellation type.
 *
 * Fixtures mirror Mongo: `{ itemId, boardId, data }` keyed by the ISO+ attribute
 * name. Every expected amount is derived by hand.
 *
 * Sydney conversions used in the expected descriptions:
 *   2026-01-14T21:00Z -> 15/01/2026, 08:00 am
 *   2026-01-14T22:00Z -> 15/01/2026, 09:00 am
 *   2026-01-15T00:00Z -> 15/01/2026, 11:00 am
 *   2026-01-15T00:30Z -> 15/01/2026, 11:30 am
 */

const TZ = 'Australia/Sydney';
const ITEM_ID = 'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce';

const ACTUAL_START = '2026-01-14T22:00:00.000Z';
const ACTUAL_END = '2026-01-15T00:30:00.000Z';
const SCHEDULED_START = '2026-01-14T21:00:00.000Z';
const SCHEDULED_END = '2026-01-15T00:00:00.000Z';

const ATTR = {
  PROVIDER_MILEAGE: 'Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a vehicle is used.',
  PROVIDER_OTHERS: 'Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied.',
  ACTIVITY_MILEAGE: 'Activity Base Transport Mileage(Kms) as per the Service Plan, if a vehicle is used.',
  ACTIVITY_OTHERS: 'Activity Base Transport Costs as per the Service Plan, if other costs are applied.',
  LABOUR_MIN: 'Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.',
  NF2F_HOURS: 'Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)',
  USED_ALLOWANCE: 'Used Allowance Amount($) as per the Service Plan',
};

const masterPlan = (data) => ({ itemId: ITEM_ID, boardId: 'board-1', data });

const baseMasterData = (overrides = {}) => ({
  'Job Status': 'Completed',
  'Payment Status': 'Unpaid',
  'Group Size': '1',
  'Scheduled Shift Start Date & Time': SCHEDULED_START,
  'Scheduled Shift End Date & Time': SCHEDULED_END,
  'Actual Shift Start Date and Time': ACTUAL_START,
  'Actual Shift End Date and Time': ACTUAL_END,
  'Actual Shift Duration(Hr.)': '2.5',
  'Scheduled Shift Duration(Hr.)': '3',
  ...overrides,
});

const servicePlan = (overrides = {}) => ({
  itemId: 'sp-1',
  boardId: 'board-1',
  data: {
    'Direct Support Item Number': [{ id: 'ds-ref', name: 'Direct Support' }],
    'Unit (Direct Support)': 'Hour(H)',
    'Agreed Unit Price for Direct Support ($)': '70.00',
    ...overrides,
  },
});

const DIRECT_SUPPORT_CATALOGUE_ITEM = {
  data: {
    'Support Item Number': '01_011_0107_1_1',
    'Support Item Name': 'Assistance With Self-Care Activities',
  },
};

const catalogue = (overrides = {}) => ({
  directSupport: DIRECT_SUPPORT_CATALOGUE_ITEM,
  providerTravelNonLabour: null,
  activityTransport: null,
  centreCapital: null,
  ...overrides,
});

function build(overrides = {}) {
  return buildLegacyNdisMasterPlanServiceRows({
    masterPlanItem: masterPlan(baseMasterData()),
    participantName: 'Samuel Rivers',
    participantProfileItem: null,
    servicePlanItem: servicePlan(),
    supportCatalogue: catalogue(),
    cancellationTypeItem: null,
    invoiceNumber: undefined,
    invoicePdfLink: null,
    timeZone: TZ,
    ...overrides,
  });
}

describe('direct support - time based', () => {
  // Breaks on a wrong group divisor, a dropped round1 on the hours, or a total
  // that stops being quantity * unit price.
  it('prices actual hours at the agreed rate and carries the full row shape', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Time Based Support': '175.00',
      })),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: `${ITEM_ID}:direct_support_time`,
      sourceItemId: ITEM_ID,
      status: 'pending',
      participant: 'Samuel Rivers',
      scheduledServiceDate: SCHEDULED_START,
      serviceDeliveryDate: ACTUAL_START,
      jobStatus: 'Completed',
      paymentStatus: 'Unpaid',
      invoiceNumber: undefined,
      fileUrl: null,
      gst: 'GST Free',
      code: 'direct_support_time',
      service: 'Assistance With Self-Care Activities - 01_011_0107_1_1 - from 15/01/2026, 09:00 am to 15/01/2026, 11:30 am',
      unit: 'Hour(H)',
      quantity: 2.5,
      unitPrice: 70,
      totalAmount: 175,
      supportNumber: '01_011_0107_1_1',
      claimType: '',
    });
  });

  // Breaks if the group divisor is dropped: 70 / 2 = 35, 35 * 2.5 = 87.50.
  it('divides the unit price by the group size', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Time Based Support': '175.00',
        'Group Size': '2',
      })),
    });

    expect(rows[0].unitPrice).toBe(35);
    expect(rows[0].totalAmount).toBe(87.5);
    expect(rows[0].service).toContain(' - Group Size: 2');
  });

  // Breaks if the unit test flips: a non-Hour direct support unit must take the
  // non-time branch instead, so the time-based amount is ignored.
  it('is emitted only when the direct support unit contains "Hour"', () => {
    const rows = build({
      servicePlanItem: servicePlan({ 'Unit (Direct Support)': 'Each(E)' }),
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Time Based Support': '175.00',
      })),
    });

    expect(rows).toEqual([]);
  });

  // Breaks if the derived-quantity fallback goes: 175 / 70 = 2.5.
  it('derives the quantity from the stored amount when no duration is recorded', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Time Based Support': '175.00',
        'Actual Shift Duration(Hr.)': '0',
        'Actual Shift Start Date and Time': '',
        'Actual Shift End Date and Time': '',
      })),
    });

    expect(rows[0].quantity).toBe(2.5);
    expect(rows[0].totalAmount).toBe(175);
  });

  // Breaks if the derived-unit-price fallback goes: 175 / 2.5 = 70.00.
  it('derives the unit price from the amount when the service plan has no rate', () => {
    const rows = build({
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Direct Support ($)': '' }),
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Time Based Support': '175.00',
      })),
    });

    expect(rows[0].unitPrice).toBe(70);
    expect(rows[0].totalAmount).toBe(175);
  });

  it('emits nothing when the stored amount is zero or negative', () => {
    expect(build({
      masterPlanItem: masterPlan(baseMasterData({ 'Direct Support Value($) - Time Based Support': '0' })),
    })).toEqual([]);
    expect(build({
      masterPlanItem: masterPlan(baseMasterData({ 'Direct Support Value($) - Time Based Support': '(175)' })),
    })).toEqual([]);
  });
});

describe('direct support - non time based', () => {
  const nonTimePlan = servicePlan({
    'Unit (Direct Support)': 'Each(E)',
    'Agreed Unit Price for Direct Support ($)': '25.00',
  });

  // Breaks if the quantity/unit suffix disappears, or if the group divisor is
  // wrongly applied here — non-time supports are not divided by group size.
  it('bills the stored quantity at the undivided agreed rate', () => {
    const rows = build({
      servicePlanItem: nonTimePlan,
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Non Time Based Support': '75.00',
        'Quantity (Direct Support - Non Time Based Support)': '3',
        'Group Size': '2',
      })),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('direct_support_non_time');
    expect(rows[0].quantity).toBe(3);
    expect(rows[0].unitPrice).toBe(25);
    expect(rows[0].totalAmount).toBe(75);
    expect(rows[0].unit).toBe('Each(E)');
    expect(rows[0].service)
      .toBe('Assistance With Self-Care Activities - 01_011_0107_1_1 - 3 Each(E)');
  });

  // Breaks if the total starts being recomputed: this row reports the amount
  // ISO+ stored, even when it disagrees with quantity * unit price.
  it('reports the stored amount as the total, not quantity * unit price', () => {
    const rows = build({
      servicePlanItem: nonTimePlan,
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Non Time Based Support': '80.00',
        'Quantity (Direct Support - Non Time Based Support)': '3',
      })),
    });

    expect(rows[0].quantity * rows[0].unitPrice).toBe(75);
    expect(rows[0].totalAmount).toBe(80);
  });

  // Breaks if the derived quantity goes: 87.50 / 25 = 3.5.
  it('derives the quantity from the amount when none is stored', () => {
    const rows = build({
      servicePlanItem: nonTimePlan,
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Non Time Based Support': '87.50',
      })),
    });

    expect(rows[0].quantity).toBe(3.5);
  });

  // Breaks if the derived unit price goes: 90 / 3 = 30.
  it('derives the unit price from the amount when the plan has no rate', () => {
    const rows = build({
      servicePlanItem: servicePlan({
        'Unit (Direct Support)': 'Each(E)',
        'Agreed Unit Price for Direct Support ($)': '0',
      }),
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Non Time Based Support': '90.00',
        'Quantity (Direct Support - Non Time Based Support)': '3',
      })),
    });

    expect(rows[0].unitPrice).toBe(30);
    expect(rows[0].totalAmount).toBe(90);
  });

  it('never appends a shift window to a non-time row', () => {
    const rows = build({
      servicePlanItem: nonTimePlan,
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Non Time Based Support': '25.00',
        'Quantity (Direct Support - Non Time Based Support)': '1',
      })),
    });

    expect(rows[0].service).not.toContain('from ');
  });
});

describe('provider travel and activity transport rows', () => {
  // Breaks if quantity/unitPrice stop being amount/1: these lines are claimed
  // as a dollar amount, not as kilometres.
  it('claims the stored provider travel amount at unit price 1', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Provider Travel - Non-Labour Cost Amount($)': '18.60',
        [ATTR.PROVIDER_MILEAGE]: '20',
        [ATTR.PROVIDER_OTHERS]: '2.60',
      })),
      servicePlanItem: servicePlan({
        'Unit (Provider Travel - Non-Labour Cost)': 'Each(E)',
        'Agreed Unit Price for Non-Labour Travel ($)': '0.80',
      }),
      supportCatalogue: catalogue({
        providerTravelNonLabour: {
          data: { 'Support Item Number': '01_799_0107_1_1', 'Support Item Name': 'Provider Travel' },
        },
      }),
    });

    const travel = rows.find((r) => r.code === 'provider_travel_non_labour');
    expect(travel.quantity).toBe(18.6);
    expect(travel.unitPrice).toBe(1);
    expect(travel.totalAmount).toBe(18.6);
    expect(travel.unit).toBe('Each(E)');
    expect(travel.supportNumber).toBe('01_799_0107_1_1');
    expect(travel.service).toBe('Provider Travel - 01_799_0107_1_1 - 20km - Others: 2.6');
  });

  // Breaks on a wrong fallback formula: 0.80 * 20 + 2.60 = 18.60.
  it('computes the provider travel amount from mileage when none is stored', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        [ATTR.PROVIDER_MILEAGE]: '20',
        [ATTR.PROVIDER_OTHERS]: '2.60',
      })),
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Non-Labour Travel ($)': '0.80' }),
    });

    expect(rows.find((r) => r.code === 'provider_travel_non_labour').totalAmount).toBe(18.6);
  });

  // Breaks if the default unit changes: activity transport defaults to Each(E),
  // provider travel to the empty string.
  it('claims activity based transport with the Each(E) default unit', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Activity Base Transport Amount($)': '12.00',
        [ATTR.ACTIVITY_MILEAGE]: '15',
        [ATTR.ACTIVITY_OTHERS]: '1.50',
      })),
    });

    const abt = rows.find((r) => r.code === 'activity_transport');
    expect(abt.unit).toBe('Each(E)');
    expect(abt.quantity).toBe(12);
    expect(abt.unitPrice).toBe(1);
    expect(abt.totalAmount).toBe(12);
    expect(abt.service).toBe('Activity Based Transport Item - 15km - Others: 1.5');
  });

  it('computes the activity transport amount from mileage when none is stored', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({ [ATTR.ACTIVITY_MILEAGE]: '15' })),
      servicePlanItem: servicePlan({ 'Agreed Price for Activity Based Transport ($)': '1.20' }),
    });

    // 1.20 * 15 + 0 = 18.00
    expect(rows.find((r) => r.code === 'activity_transport').totalAmount).toBe(18);
  });

  it('emits neither travel row when both amounts are zero', () => {
    expect(build().map((r) => r.code)).toEqual([]);
  });
});

describe('centre capital costs row', () => {
  // Breaks if the hours or the rate stop driving this line: centre capital is
  // billed per delivered hour.
  it('bills the actual hours at the agreed centre capital rate', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({ 'Centre Capital Costs Amount($)': '30.00' })),
      servicePlanItem: servicePlan({
        'Unit (Centre Capital Costs)': 'Hour(H)',
        'Agreed Unit Price for Centre Capital Costs($)': '12.00',
      }),
      supportCatalogue: catalogue({
        centreCapital: { data: { 'Support Item Number': '01_011_0107_1_1_CC', 'Support Item Name': 'Centre Capital' } },
      }),
    });

    const centre = rows.find((r) => r.code === 'centre_capital_costs');
    expect(centre.quantity).toBe(2.5);
    expect(centre.unitPrice).toBe(12);
    expect(centre.totalAmount).toBe(30);
    expect(centre.service)
      .toBe('Centre Capital - 01_011_0107_1_1_CC - from 15/01/2026, 09:00 am to 15/01/2026, 11:30 am');
  });

  // Breaks if the amount is no longer computed when absent: 2.5 * 12 = 30.
  it('computes the amount from hours * rate when nothing is stored', () => {
    const rows = build({
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Centre Capital Costs($)': '12.00' }),
    });

    expect(rows.find((r) => r.code === 'centre_capital_costs').totalAmount).toBe(30);
  });

  // Breaks if the derived quantity goes: 30 / 12 = 2.5 with no duration stored.
  it('derives the quantity from amount / rate when no duration is recorded', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Centre Capital Costs Amount($)': '30.00',
        'Actual Shift Duration(Hr.)': '0',
        'Actual Shift Start Date and Time': '',
        'Actual Shift End Date and Time': '',
      })),
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Centre Capital Costs($)': '12.00' }),
    });

    expect(rows.find((r) => r.code === 'centre_capital_costs').quantity).toBe(2.5);
  });

  it('emits nothing when neither an amount nor a rate is available', () => {
    expect(build({ masterPlanItem: masterPlan(baseMasterData()) })
      .some((r) => r.code === 'centre_capital_costs')).toBe(false);
  });
});

describe('labour travel time row', () => {
  // Breaks on the minutes->hours conversion, or if the claim type stops being
  // TRAN, which is the NDIA code for a travel claim.
  it('converts minutes to hours, claims TRAN and reports the stored amount', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Labour Travel Time Amount($)': '48.75',
        [ATTR.LABOUR_MIN]: '45',
      })),
      servicePlanItem: servicePlan({
        'Unit (Labour Travel Time)': 'Hour(H)',
        'Agreed Unit Price for Labour Travel Time ($)': '65.00',
      }),
    });

    const ltt = rows.find((r) => r.code === 'labour_travel_time');
    // round1(45 / 60) = round1(0.75) = 0.8.
    expect(ltt.quantity).toBe(0.8);
    expect(ltt.unitPrice).toBe(65);
    // Characterizing a real inconsistency: the total is the stored amount, not
    // quantity * unitPrice (0.8 * 65 = 52.00).
    expect(ltt.totalAmount).toBe(48.75);
    expect(ltt.claimType).toBe('TRAN');
    // The legacy row claims travel against the DIRECT SUPPORT item number,
    // because the legacy service plan has no labour-travel item column.
    expect(ltt.supportNumber).toBe('01_011_0107_1_1');
  });

  it('emits no labour travel row without both minutes and a rate', () => {
    expect(build({
      masterPlanItem: masterPlan(baseMasterData({ 'Labour Travel Time Amount($)': '48.75' })),
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Labour Travel Time ($)': '65.00' }),
    }).some((r) => r.code === 'labour_travel_time')).toBe(false);

    expect(build({
      masterPlanItem: masterPlan(baseMasterData({
        'Labour Travel Time Amount($)': '48.75',
        [ATTR.LABOUR_MIN]: '45',
      })),
    }).some((r) => r.code === 'labour_travel_time')).toBe(false);
  });
});

describe('allowances row', () => {
  // Breaks if quantity stops being 1 or the used-allowance column stops being
  // preferred as the unit price.
  it('bills one unit at the used allowance amount', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Allowances Amount($)': '35.00',
        [ATTR.USED_ALLOWANCE]: '35.00',
        Allowances: 'Sleepover',
      })),
      servicePlanItem: servicePlan({ 'Unit (Allowances)': 'Each(E)' }),
    });

    const allowance = rows.find((r) => r.code === 'allowances');
    expect(allowance.quantity).toBe(1);
    expect(allowance.unitPrice).toBe(35);
    expect(allowance.totalAmount).toBe(35);
    expect(allowance.unit).toBe('Each(E)');
    expect(allowance.service).toBe('Allowances - Sleepover');
    expect(allowance.supportNumber).toBe('01_011_0107_1_1');
    expect(allowance.claimType).toBe('');
  });

  it('falls back to the allowances amount when no used amount is recorded', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({ 'Allowances Amount($)': '20.00' })),
    });

    expect(rows.find((r) => r.code === 'allowances').unitPrice).toBe(20);
  });

  // Breaks if the REPW rule loosens or tightens.
  it('claims an NDIA-requested report as REPW, other reports as blank', () => {
    const claimTypeFor = (allowances) => build({
      masterPlanItem: masterPlan(baseMasterData({ 'Allowances Amount($)': '50.00', Allowances: allowances })),
    }).find((r) => r.code === 'allowances').claimType;

    expect(claimTypeFor('NDIA Requested Reports')).toBe('REPW');
    expect(claimTypeFor('Mandatory Report')).toBe('REPW');
    expect(claimTypeFor('Progress report')).toBe('');
    expect(claimTypeFor('Sleepover')).toBe('');
  });
});

describe('non-face-to-face row', () => {
  // Breaks on a lost NF2F claim type or a quantity that stops being the
  // recorded non-face-to-face hours.
  it('bills the recorded hours at the agreed rate and claims NF2F', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Non-Face-to-Face Amount($)': '90.00',
        [ATTR.NF2F_HOURS]: '1.5',
        'Non-Face-to-Face Supports': 'Report writing',
      })),
      servicePlanItem: servicePlan({
        'Unit (Non-Face-to-Face Support)': 'Hour(H)',
        'Agreed Unit Price for Non-Face-to-Face Support($)': '60.00',
      }),
    });

    const nf2f = rows.find((r) => r.code === 'non_face_to_face');
    expect(nf2f.quantity).toBe(1.5);
    expect(nf2f.unitPrice).toBe(60);
    expect(nf2f.totalAmount).toBe(90);
    expect(nf2f.claimType).toBe('NF2F');
    expect(nf2f.service)
      .toBe('Non-Face-to-Face Support - Report writing - 01_011_0107_1_1 - from 15/01/2026, 09:00 am to 15/01/2026, 11:30 am');
  });

  it('emits nothing without both hours and a rate', () => {
    expect(build({
      masterPlanItem: masterPlan(baseMasterData({ 'Non-Face-to-Face Amount($)': '90.00' })),
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Non-Face-to-Face Support($)': '60.00' }),
    }).some((r) => r.code === 'non_face_to_face')).toBe(false);

    expect(build({
      masterPlanItem: masterPlan(baseMasterData({
        'Non-Face-to-Face Amount($)': '90.00',
        [ATTR.NF2F_HOURS]: '1.5',
      })),
    }).some((r) => r.code === 'non_face_to_face')).toBe(false);
  });
});

describe('all delivered rows together', () => {
  // Breaks if a builder is dropped from the pipeline or reordered — the row
  // order is the invoice line order.
  it('emits the eight delivered line types in a fixed order', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Time Based Support': '175.00',
        'Provider Travel - Non-Labour Cost Amount($)': '18.60',
        'Activity Base Transport Amount($)': '12.00',
        'Centre Capital Costs Amount($)': '30.00',
        'Labour Travel Time Amount($)': '48.75',
        [ATTR.LABOUR_MIN]: '45',
        'Allowances Amount($)': '35.00',
        'Non-Face-to-Face Amount($)': '90.00',
        [ATTR.NF2F_HOURS]: '1.5',
      })),
      servicePlanItem: servicePlan({
        'Agreed Unit Price for Centre Capital Costs($)': '12.00',
        'Agreed Unit Price for Labour Travel Time ($)': '65.00',
        'Agreed Unit Price for Non-Face-to-Face Support($)': '60.00',
      }),
    });

    expect(rows.map((r) => r.code)).toEqual([
      'direct_support_time',
      'provider_travel_non_labour',
      'activity_transport',
      'centre_capital_costs',
      'labour_travel_time',
      'allowances',
      'non_face_to_face',
    ]);
    // 175 + 18.60 + 12 + 30 + 48.75 + 35 + 90
    expect(rows.reduce((sum, r) => sum + r.totalAmount, 0)).toBeCloseTo(409.35, 2);
  });
});

describe('cancelled shift', () => {
  const cancellationType = (pct) => ({ data: { 'Billable to Client %': pct } });

  const cancelledMaster = (overrides = {}) => masterPlan(baseMasterData({
    'Job Status': 'Cancelled',
    'Cancellation Fee($)': '189.00',
    'Direct Support Value($) - Time Based Support': '175.00',
    'Allowances Amount($)': '35.00',
    ...overrides,
  }));

  // Breaks on a wrong billable percentage, a wrong quantity, or on delivered
  // rows leaking into a cancelled shift.
  it('recomputes the direct support cancellation from the billable percentage', () => {
    const rows = build({
      masterPlanItem: cancelledMaster(),
      cancellationTypeItem: cancellationType('90'),
      supportCatalogue: catalogue({
        directSupport: {
          data: {
            ...DIRECT_SUPPORT_CATALOGUE_ITEM.data,
            'Short Notice Cancellations': 'Y',
          },
        },
      }),
    });

    expect(rows.map((r) => r.code)).toEqual(['canc_direct_support']);
    // 70 * 90% = 63.00; 3 scheduled hours * 63.00 = 189.00
    expect(rows[0].quantity).toBe(3);
    expect(rows[0].unitPrice).toBe(63);
    expect(rows[0].totalAmount).toBe(189);
    expect(rows[0].claimType).toBe('CANC');
    expect(rows[0].service)
      .toBe('Cancellation Fee - Assistance With Self-Care Activities - 01_011_0107_1_1 - from 15/01/2026, 08:00 am to 15/01/2026, 11:00 am - 90%');
  });

  // Breaks if the short-notice flag stops gating the charge: charging a
  // cancellation for an item the catalogue does not allow it on is a
  // non-compliant claim.
  it('charges nothing for a component the catalogue does not allow cancelling', () => {
    const rows = build({
      masterPlanItem: cancelledMaster(),
      cancellationTypeItem: cancellationType('90'),
      supportCatalogue: catalogue({
        directSupport: {
          data: { ...DIRECT_SUPPORT_CATALOGUE_ITEM.data, 'Short Notice Cancellations': 'N' },
        },
      }),
    });

    expect(rows).toEqual([]);
  });

  // Breaks if the components stop being independent: each catalogue item
  // carries its own short-notice flag and its own rate.
  it('emits one row per short-notice-eligible component', () => {
    const rows = build({
      masterPlanItem: cancelledMaster(),
      cancellationTypeItem: cancellationType('100'),
      servicePlanItem: servicePlan({
        'Unit (Provider Travel - Non-Labour Cost)': 'Each(E)',
        'Agreed Unit Price for Non-Labour Travel ($)': '0.80',
        'Unit (Activity Based Transport)': 'Each(E)',
        'Agreed Price for Activity Based Transport ($)': '1.20',
        'Unit (Centre Capital Costs)': 'Hour(H)',
        'Agreed Unit Price for Centre Capital Costs($)': '12.00',
      }),
      supportCatalogue: {
        directSupport: {
          data: { ...DIRECT_SUPPORT_CATALOGUE_ITEM.data, 'Short Notice Cancellations': 'Y' },
        },
        providerTravelNonLabour: {
          data: { 'Support Item Number': 'PT-1', 'Short Notice Cancellations': 'Y' },
        },
        activityTransport: {
          data: { 'Support Item Number': 'ABT-1', 'Short Notice Cancellations': 'N' },
        },
        centreCapital: {
          data: { 'Support Item Number': 'CC-1', 'Short Notice Cancellations': 'YES' },
        },
      },
    });

    expect(rows.map((r) => r.code)).toEqual([
      'canc_direct_support',
      'canc_provider_travel',
      'canc_centre_capital',
    ]);
    expect(rows.map((r) => r.totalAmount)).toEqual([210, 2.4, 36]);
  });

  // Breaks if the group divisor is dropped from the cancellation rate: a group
  // shift cancellation would be billed per participant at the full rate.
  it('divides the hourly cancellation rate by the group size', () => {
    const rows = build({
      masterPlanItem: cancelledMaster({ 'Group Size': '2' }),
      cancellationTypeItem: cancellationType('100'),
      supportCatalogue: catalogue({
        directSupport: {
          data: { ...DIRECT_SUPPORT_CATALOGUE_ITEM.data, 'Short Notice Cancellations': 'Y' },
        },
      }),
    });

    expect(rows[0].unitPrice).toBe(35);
    expect(rows[0].totalAmount).toBe(105);
  });

  // Breaks if the non-hour cancellation stops using the stored quantity: an
  // each-based support is cancelled per unit, not per scheduled hour.
  it('uses the stored quantity and undivided rate for a non-hour direct support', () => {
    const rows = build({
      masterPlanItem: cancelledMaster({
        'Group Size': '2',
        'Quantity (Direct Support - Non Time Based Support)': '4',
      }),
      servicePlanItem: servicePlan({
        'Unit (Direct Support)': 'Each(E)',
        'Agreed Unit Price for Direct Support ($)': '25.00',
      }),
      cancellationTypeItem: cancellationType('50'),
      supportCatalogue: catalogue({
        directSupport: {
          data: { ...DIRECT_SUPPORT_CATALOGUE_ITEM.data, 'Short Notice Cancellations': 'Y' },
        },
      }),
    });

    // 25 * 50% = 12.50; 4 units * 12.50 = 50.00
    expect(rows[0].quantity).toBe(4);
    expect(rows[0].unitPrice).toBe(12.5);
    expect(rows[0].totalAmount).toBe(50);
  });

  // Breaks if the gate is removed: with no fee recorded on the master plan the
  // shift is not billable at all, whatever the catalogue says.
  it('emits nothing when no cancellation fee is recorded', () => {
    expect(build({
      masterPlanItem: cancelledMaster({ 'Cancellation Fee($)': '0' }),
      cancellationTypeItem: cancellationType('90'),
      supportCatalogue: catalogue({
        directSupport: {
          data: { ...DIRECT_SUPPORT_CATALOGUE_ITEM.data, 'Short Notice Cancellations': 'Y' },
        },
      }),
    })).toEqual([]);
  });

  // Breaks if a zero percentage starts producing a zero-dollar line, which
  // would appear on the invoice as a spurious row.
  it('emits nothing when the cancellation type is missing or 0% billable', () => {
    const withFlag = {
      masterPlanItem: cancelledMaster(),
      supportCatalogue: catalogue({
        directSupport: {
          data: { ...DIRECT_SUPPORT_CATALOGUE_ITEM.data, 'Short Notice Cancellations': 'Y' },
        },
      }),
    };

    expect(build({ ...withFlag, cancellationTypeItem: null })).toEqual([]);
    expect(build({ ...withFlag, cancellationTypeItem: cancellationType('0') })).toEqual([]);
  });

  // Breaks if the stored fee starts overriding the recomputed components: the
  // stored fee is only a gate, the claimed amount comes from the catalogue and
  // the billable percentage.
  it('ignores the stored fee amount when computing the claimed total', () => {
    const rows = build({
      masterPlanItem: cancelledMaster({ 'Cancellation Fee($)': '1.00' }),
      cancellationTypeItem: cancellationType('90'),
      supportCatalogue: catalogue({
        directSupport: {
          data: { ...DIRECT_SUPPORT_CATALOGUE_ITEM.data, 'Short Notice Cancellations': 'Y' },
        },
      }),
    });

    expect(rows[0].totalAmount).toBe(189);
  });
});

describe('row metadata', () => {
  const withDirectSupport = (extra = {}) => ({
    masterPlanItem: masterPlan(baseMasterData({
      'Direct Support Value($) - Time Based Support': '175.00',
      ...(extra.master || {}),
    })),
    ...extra.args,
  });

  it('marks a row invoiced when an invoice number is supplied', () => {
    const rows = build(withDirectSupport({
      args: { invoiceNumber: 'IN-1042', invoicePdfLink: 'https://example.com/in-1042.pdf' },
    }));

    expect(rows[0].status).toBe('invoiced');
    expect(rows[0].fileUrl).toBe('https://example.com/in-1042.pdf');
  });

  it('falls back through participant name sources', () => {
    expect(build(withDirectSupport({ args: { participantName: '' } }))[0].participant).toBe('');

    expect(build(withDirectSupport({
      args: { participantName: null, participantProfileItem: { data: { 'Preferred Name': 'Sam' } } },
    }))[0].participant).toBe('Sam');

    expect(build(withDirectSupport({
      master: { 'Participant Full Name': 'Samuel Rivers' },
      args: { participantName: null },
    }))[0].participant).toBe('Samuel Rivers');
  });

  // Breaks if the fallback status columns are dropped: ISO+ boards use either
  // "Job Status" or "Shift Status" and the cancelled branch depends on it.
  it('reads the shift status from either column', () => {
    const rows = buildLegacyNdisMasterPlanServiceRows({
      masterPlanItem: masterPlan({
        ...baseMasterData(),
        'Job Status': undefined,
        'Shift Status': 'Cancelled',
        'Cancellation Fee($)': '100.00',
      }),
      servicePlanItem: servicePlan(),
      cancellationTypeItem: { data: { 'Billable to Client %': '100' } },
      supportCatalogue: catalogue({
        directSupport: {
          data: { ...DIRECT_SUPPORT_CATALOGUE_ITEM.data, 'Short Notice Cancellations': 'Y' },
        },
      }),
      timeZone: TZ,
    });

    expect(rows.map((r) => r.code)).toEqual(['canc_direct_support']);
    expect(rows[0].jobStatus).toBe('Cancelled');
  });

  // Breaks if the service-plan text stops being the fallback item number, which
  // is what boards without a linked catalogue item rely on.
  it('falls back to the service plan item number when the catalogue is empty', () => {
    const rows = build({
      supportCatalogue: {},
      servicePlanItem: servicePlan({ 'Direct Support Item Number': '01_099_0999_1_1' }),
      masterPlanItem: masterPlan(baseMasterData({
        'Direct Support Value($) - Time Based Support': '175.00',
      })),
    });

    expect(rows[0].supportNumber).toBe('01_099_0999_1_1');
  });

  it('survives a completely empty master plan item', () => {
    expect(buildLegacyNdisMasterPlanServiceRows({ masterPlanItem: null })).toEqual([]);
    expect(buildLegacyNdisMasterPlanServiceRows({})).toEqual([]);
  });
});
