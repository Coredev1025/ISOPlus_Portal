import { describe, it, expect } from 'vitest';
import { buildNewNdisMasterPlanServiceRows } from '../../../src/utils/ndisNewMasterPlanServiceHelpers.js';

/*
 * buildNewNdisMasterPlanServiceRows() expands one Master Plan shift into the
 * invoice/claim rows under the 2026-27 NDIS Pricing Schedule ("new" rule).
 * Compared with the legacy rule it collapses direct support / centre capital
 * into a single "Support" line, prices cancellations from the service plan's
 * own Cancellation columns, and carries its own catalogue slots.
 *
 * Fixtures mirror Mongo: `{ itemId, boardId, data }` with `data` keyed by the
 * ISO+ attribute name. Every expected amount below is derived by hand.
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
    'Support Item Number': [{ id: 'sup-ref', name: 'Support' }],
    'Unit (Support)': 'Hour',
    'Agreed Unit Price for Support ($)': '80.00',
    ...overrides,
  },
});

const catalogue = (overrides = {}) => ({
  support: {
    data: {
      'Support Item Number': '01_011_0107_1_1',
      'Support Item Name': 'Assistance With Self-Care Activities',
    },
  },
  providerTravelNonLabour: null,
  labourTravelTime: null,
  cancellation: null,
  activityTransport: null,
  ...overrides,
});

function build(overrides = {}) {
  return buildNewNdisMasterPlanServiceRows({
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

describe('support row (hour unit)', () => {
  // Breaks on a wrong group-size division, a dropped round1 on the duration, or
  // a total that stops being quantity * unit price.
  it('prices actual hours at the agreed rate and carries the full row shape', () => {
    const rows = build();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: `${ITEM_ID}:support`,
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
      code: 'support',
      service: 'Assistance With Self-Care Activities - 01_011_0107_1_1 - from 15/01/2026, 09:00 am to 15/01/2026, 11:30 am',
      unit: 'Hour',
      quantity: 2.5,
      unitPrice: 80,
      totalAmount: 200,
      supportNumber: '01_011_0107_1_1',
      claimType: '',
    });
  });

  // Breaks if the group divisor is dropped: a 3-participant group shift would
  // be billed three times over. 80 / 4 = 20; 20 * 2.5 = 50.
  it('divides the unit price by the group size and names it in the description', () => {
    const rows = build({ masterPlanItem: masterPlan(baseMasterData({ 'Group Size': '4' })) });

    expect(rows[0].unitPrice).toBe(20);
    expect(rows[0].quantity).toBe(2.5);
    expect(rows[0].totalAmount).toBe(50);
    expect(rows[0].service).toContain(' - Group Size: 4');
  });

  // Breaks if the derived-quantity fallback goes: with no stored duration the
  // hours must be recovered from amount / rate (160 / 80 = 2), not left at 0.
  it('derives the quantity from the stored amount when no duration is recorded', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Actual Shift Duration(Hr.)': '0',
        'Actual Shift Start Date and Time': '',
        'Actual Shift End Date and Time': '',
        'Support Value($)': '160.00',
      })),
    });

    expect(rows[0].quantity).toBe(2);
    expect(rows[0].unitPrice).toBe(80);
    expect(rows[0].totalAmount).toBe(160);
  });

  // Breaks if the duration is not computed from the timestamps: 22:00Z -> 00:30Z
  // is 2.5h, and without it the row would be dropped entirely.
  it('computes the duration from the actual timestamps when the field is blank', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({ 'Actual Shift Duration(Hr.)': '' })),
    });

    expect(rows[0].quantity).toBe(2.5);
    expect(rows[0].totalAmount).toBe(200);
  });

  // Breaks if the derived-unit-price fallback goes: 187.50 / 2.5 = 75.00.
  it('derives the unit price from the amount when the service plan has no rate', () => {
    const rows = build({
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Support ($)': '' }),
      masterPlanItem: masterPlan(baseMasterData({ 'Support Value($)': '187.50' })),
    });

    expect(rows[0].unitPrice).toBe(75);
    expect(rows[0].quantity).toBe(2.5);
    expect(rows[0].totalAmount).toBe(187.5);
  });

  // Breaks if the guard weakens: a row with no quantity or no price is not
  // claimable and must not reach the invoice at all.
  it('emits no row when quantity or unit price resolves to zero', () => {
    expect(build({
      masterPlanItem: masterPlan(baseMasterData({
        'Actual Shift Duration(Hr.)': '0',
        'Actual Shift Start Date and Time': '',
        'Actual Shift End Date and Time': '',
      })),
    })).toEqual([]);

    expect(build({
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Support ($)': '0' }),
    })).toEqual([]);
  });

  // Breaks if the stored amount starts overriding the computed total: the row
  // total is quantity * rate, so a stale Support Value($) is ignored.
  it('ignores a stored Support Value that disagrees with quantity * rate', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({ 'Support Value($)': '9999.00' })),
    });

    expect(rows[0].totalAmount).toBe(200);
  });

  // Breaks if the legacy fallbacks are removed from the amount lookup, which
  // migrated boards still rely on to derive the quantity.
  it('falls back to the legacy Direct Support amount columns', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Actual Shift Duration(Hr.)': '0',
        'Actual Shift Start Date and Time': '',
        'Actual Shift End Date and Time': '',
        'Direct Support Value($) - Time Based Support': '240.00',
      })),
    });

    expect(rows[0].quantity).toBe(3);
    expect(rows[0].totalAmount).toBe(240);
  });
});

describe('support row (non-hour unit)', () => {
  const nonHourPlan = servicePlan({
    'Unit (Support)': 'Each',
    'Agreed Unit Price for Support ($)': '25.00',
  });

  // Breaks if the non-hour branch stops reading the quantity column, or if the
  // quantity/unit suffix disappears from the description.
  it('prices the stored quantity and appends it to the description', () => {
    const rows = build({
      servicePlanItem: nonHourPlan,
      masterPlanItem: masterPlan(baseMasterData({ 'Quantity (Non-Time-Based Support)': '3' })),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('support_non_time');
    expect(rows[0].unit).toBe('Each');
    expect(rows[0].quantity).toBe(3);
    expect(rows[0].unitPrice).toBe(25);
    expect(rows[0].totalAmount).toBe(75);
    expect(rows[0].service)
      .toBe('Assistance With Self-Care Activities - 01_011_0107_1_1 - 3 Each');
  });

  it('falls back to the legacy non-time quantity column', () => {
    const rows = build({
      servicePlanItem: nonHourPlan,
      masterPlanItem: masterPlan(baseMasterData({
        'Quantity (Direct Support - Non Time Based Support)': '2',
      })),
    });

    expect(rows[0].quantity).toBe(2);
    expect(rows[0].totalAmount).toBe(50);
  });

  // Breaks if the derived quantity is lost: 87.50 / 25 = 3.5.
  it('derives the quantity from the amount when none is stored', () => {
    const rows = build({
      servicePlanItem: nonHourPlan,
      masterPlanItem: masterPlan(baseMasterData({ 'Support Value($)': '87.50' })),
    });

    expect(rows[0].quantity).toBe(3.5);
    expect(rows[0].totalAmount).toBe(87.5);
  });

  it('emits no row when neither a quantity nor an amount is available', () => {
    expect(build({ servicePlanItem: nonHourPlan })).toEqual([]);
  });

  // Breaks if the non-hour branch starts appending the shift window, which is
  // meaningless for an each-based support.
  it('never appends a time range to a non-hour row', () => {
    const rows = build({
      servicePlanItem: nonHourPlan,
      masterPlanItem: masterPlan(baseMasterData({ 'Quantity (Non-Time-Based Support)': '1' })),
    });

    expect(rows[0].service).not.toContain('from ');
  });
});

describe('provider travel and activity transport rows', () => {
  // Breaks if quantity/unitPrice stop being amount/1 — these lines are claimed
  // as a dollar amount at unit price 1, not as kilometres.
  it('claims the stored provider travel amount at unit price 1', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Provider Travel - Non-Labour Cost Amount($)': '18.60',
        'Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a vehicle is used.': '20',
        'Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied.': '2.60',
      })),
      servicePlanItem: servicePlan({
        'Unit (Provider Travel - Non-Labour Cost)': 'Each',
        'Agreed Unit Price for Non-Labour Travel ($)': '0.80',
      }),
      supportCatalogue: catalogue({
        providerTravelNonLabour: { data: { 'Support Item Number': '01_799_0107_1_1', 'Support Item Name': 'Provider Travel' } },
      }),
    });

    const travel = rows.find((r) => r.code === 'provider_travel_non_labour');
    expect(travel.quantity).toBe(18.6);
    expect(travel.unitPrice).toBe(1);
    expect(travel.totalAmount).toBe(18.6);
    expect(travel.unit).toBe('Each');
    expect(travel.supportNumber).toBe('01_799_0107_1_1');
    expect(travel.service).toBe('Provider Travel - 01_799_0107_1_1 - 20km - Others: 2.6');
  });

  // Breaks on a wrong fallback formula: 0.80 * 20 + 2.60 = 18.60.
  it('computes the provider travel amount from mileage when none is stored', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a vehicle is used.': '20',
        'Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied.': '2.60',
      })),
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Non-Labour Travel ($)': '0.80' }),
    });

    expect(rows.find((r) => r.code === 'provider_travel_non_labour').totalAmount).toBe(18.6);
  });

  it('reads the "($)" spelling of the other-costs column', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied ($)': '5.00',
      })),
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Non-Labour Travel ($)': '0' }),
    });

    expect(rows.find((r) => r.code === 'provider_travel_non_labour').totalAmount).toBe(5);
  });

  // Breaks if the default unit changes: activity transport defaults to Each(E)
  // while provider travel defaults to the empty string.
  it('claims activity based transport with the Each(E) default unit', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Activity Base Transport Amount($)': '12.00',
        'Activity Base Transport Mileage(Kms) as per the Service Plan, if a vehicle is used.': '15',
      })),
    });

    const abt = rows.find((r) => r.code === 'activity_transport');
    expect(abt.unit).toBe('Each(E)');
    expect(abt.quantity).toBe(12);
    expect(abt.unitPrice).toBe(1);
    expect(abt.totalAmount).toBe(12);
    expect(abt.service).toBe('Activity Based Transport Item - 15km');
  });

  it('emits neither travel row when both amounts are zero', () => {
    expect(build().map((r) => r.code)).toEqual(['support']);
  });
});

describe('labour travel time row', () => {
  // Breaks on the minutes->hours conversion (45/60 = 0.75) or if the total ever
  // stops being the amount already stored on the master plan.
  it('converts minutes to hours and reports the stored amount as the total', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Labour Travel Time Amount($)': '48.75',
        'Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.': '45',
      })),
      servicePlanItem: servicePlan({
        'Unit (Labour Travel Time)': 'Hour',
        'Agreed Unit Price for Labour Travel Time ($)': '65.00',
        'Provider Travel - Labour Travel Time Costs Item Number': [{ id: 'ltt-ref' }],
      }),
      supportCatalogue: catalogue({
        labourTravelTime: { data: { 'Support Item Number': '01_799_0107_1_1_PT', 'Support Item Name': 'Labour Travel' } },
      }),
    });

    const ltt = rows.find((r) => r.code === 'labour_travel_time');
    // round1(45 / 60) = round1(0.75) = 0.8 — the quantity is rounded to 0.1h.
    expect(ltt.quantity).toBe(0.8);
    expect(ltt.unitPrice).toBe(65);
    // Characterizing a real inconsistency: the total is the amount ISO+ already
    // stored (48.75), NOT quantity * unitPrice (0.8 * 65 = 52.00). An invoice
    // line therefore shows figures that do not multiply out.
    expect(ltt.totalAmount).toBe(48.75);
    expect(ltt.quantity * ltt.unitPrice).toBe(52);
    expect(ltt.supportNumber).toBe('01_799_0107_1_1_PT');
    // The _PT suffix on the item number drives the claim type.
    expect(ltt.claimType).toBe('PT');
  });

  // Breaks if the row stops being suppressed: without minutes or a rate there
  // is nothing claimable even though an amount is stored.
  it('emits no labour travel row without both minutes and a rate', () => {
    const withoutMinutes = build({
      masterPlanItem: masterPlan(baseMasterData({ 'Labour Travel Time Amount($)': '48.75' })),
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Labour Travel Time ($)': '65.00' }),
    });
    expect(withoutMinutes.some((r) => r.code === 'labour_travel_time')).toBe(false);

    const withoutRate = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Labour Travel Time Amount($)': '48.75',
        'Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.': '45',
      })),
    });
    expect(withoutRate.some((r) => r.code === 'labour_travel_time')).toBe(false);
  });

  it('names the row from the fallback when the catalogue has no item', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Labour Travel Time Amount($)': '10.00',
        'Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.': '60',
      })),
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Labour Travel Time ($)': '10.00' }),
    });

    const ltt = rows.find((r) => r.code === 'labour_travel_time');
    // The unit falls back to 'Hour', so the shift window is appended.
    expect(ltt.service)
      .toBe('Provider Travel - Labour Travel Time Costs - from 15/01/2026, 09:00 am to 15/01/2026, 11:30 am');
    expect(ltt.unit).toBe('Hour');
    expect(ltt.quantity).toBe(1);
  });
});

describe('allowances row', () => {
  // Breaks if the unit price stops preferring the Used Allowance column, or if
  // quantity stops being fixed at 1.
  it('bills one unit at the used allowance amount', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Allowances Amount($)': '35.00',
        'Used Allowance Amount($) as per the Service Plan': '35.00',
        Allowances: 'Sleepover',
      })),
      servicePlanItem: servicePlan({ 'Unit (Allowances)': 'Each' }),
    });

    const allowance = rows.find((r) => r.code === 'allowances');
    expect(allowance.quantity).toBe(1);
    expect(allowance.unitPrice).toBe(35);
    expect(allowance.totalAmount).toBe(35);
    expect(allowance.unit).toBe('Each');
    expect(allowance.service).toBe('Allowances - Sleepover');
    expect(allowance.claimType).toBe('');
    // The allowance line is claimed against the support item number.
    expect(allowance.supportNumber).toBe('01_011_0107_1_1');
  });

  it('falls back to the allowances amount when no used amount is recorded', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({ 'Allowances Amount($)': '20.00' })),
    });

    const allowance = rows.find((r) => r.code === 'allowances');
    expect(allowance.unitPrice).toBe(20);
    expect(allowance.service).toBe('Allowances');
  });

  // Breaks if the REPW rule loosens or tightens: an NDIA-requested report is
  // claimed under a different NDIA claim type from an ordinary allowance.
  it('claims an NDIA-requested report as REPW, other reports as blank', () => {
    const claimTypeFor = (allowances) => build({
      masterPlanItem: masterPlan(baseMasterData({ 'Allowances Amount($)': '50.00', Allowances: allowances })),
    }).find((r) => r.code === 'allowances').claimType;

    expect(claimTypeFor('NDIA Requested Reports')).toBe('REPW');
    expect(claimTypeFor('Mandatory report')).toBe('REPW');
    expect(claimTypeFor('Required Reporting')).toBe('REPW');
    expect(claimTypeFor('Progress report')).toBe('');
    expect(claimTypeFor('NDIA meeting')).toBe('');
    expect(claimTypeFor('Sleepover')).toBe('');
  });

  it('resolves a reference-shaped allowance type to its label', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Allowances Amount($)': '50.00',
        Allowances: [{ id: 'a-1', name: 'NDIA Requested Reports' }],
      })),
    });

    const allowance = rows.find((r) => r.code === 'allowances');
    expect(allowance.service).toBe('Allowances - NDIA Requested Reports');
    expect(allowance.claimType).toBe('REPW');
  });
});

describe('cancelled shift', () => {
  const cancelledMaster = (overrides = {}) => masterPlan(baseMasterData({
    'Job Status': 'Cancelled',
    'Cancellation Fee($)': '150.00',
    'Support Value($)': '200.00',
    'Allowances Amount($)': '35.00',
    ...overrides,
  }));

  // Breaks if a cancelled shift starts emitting service rows: only the
  // cancellation line may be claimed.
  it('emits only the cancellation row and suppresses every service row', () => {
    const rows = build({
      masterPlanItem: cancelledMaster(),
      servicePlanItem: servicePlan({
        'Unit (Cancellation)': 'Hour',
        'Agreed Unit Price for Cancellation ($)': '50.00',
        'Cancellation Item Number': [{ id: 'canc-ref' }],
      }),
      supportCatalogue: catalogue({
        cancellation: { data: { 'Support Item Number': '01_011_0107_1_1', 'Support Item Name': 'Cancellation' } },
      }),
    });

    expect(rows.map((r) => r.code)).toEqual(['canc_support']);
    expect(rows[0].quantity).toBe(3); // scheduled duration
    expect(rows[0].unitPrice).toBe(50);
    expect(rows[0].totalAmount).toBe(150);
    expect(rows[0].claimType).toBe('CANC');
    expect(rows[0].unit).toBe('Hour');
    expect(rows[0].jobStatus).toBe('Cancelled');
    expect(rows[0].service)
      .toBe('Cancellation - 01_011_0107_1_1 - from 15/01/2026, 08:00 am to 15/01/2026, 11:00 am');
  });

  // Breaks if the derived unit price goes: with no agreed cancellation rate the
  // fee is spread over the scheduled hours (150 / 3 = 50).
  it('derives the cancellation unit price from the fee when the plan has no rate', () => {
    const rows = build({ masterPlanItem: cancelledMaster() });

    expect(rows[0].unitPrice).toBe(50);
    expect(rows[0].totalAmount).toBe(150);
  });

  // Breaks if the agreed rate stops taking precedence: the claimed total is
  // hours * agreed rate (3 * 60 = 180), not the stored fee.
  it('bills hours * agreed rate even when it disagrees with the stored fee', () => {
    const rows = build({
      masterPlanItem: cancelledMaster(),
      servicePlanItem: servicePlan({ 'Agreed Unit Price for Cancellation ($)': '60.00' }),
    });

    expect(rows[0].totalAmount).toBe(180);
  });

  it('emits nothing when there is no cancellation fee', () => {
    expect(build({ masterPlanItem: cancelledMaster({ 'Cancellation Fee($)': '0' }) })).toEqual([]);
  });

  // Breaks if the zero-duration guard goes, which would divide by zero and put
  // an Infinity or NaN unit price on the claim.
  it('emits nothing when the scheduled duration is zero', () => {
    expect(build({
      masterPlanItem: cancelledMaster({
        'Scheduled Shift Duration(Hr.)': '0',
        'Scheduled Shift Start Date & Time': '',
        'Scheduled Shift End Date & Time': '',
      }),
    })).toEqual([]);
  });

  // Breaks if the fallback duration computation goes: 21:00Z -> 00:00Z is 3h.
  it('computes the scheduled duration from the timestamps when the field is blank', () => {
    const rows = build({ masterPlanItem: cancelledMaster({ 'Scheduled Shift Duration(Hr.)': '' }) });

    expect(rows[0].quantity).toBe(3);
  });

  it('recognises the Shift Status column as the cancellation trigger', () => {
    const rows = build({
      masterPlanItem: masterPlan({
        ...baseMasterData(),
        'Job Status': undefined,
        'Shift Status': 'Cancelled',
        'Cancellation Fee($)': '90.00',
      }),
    });

    expect(rows.map((r) => r.code)).toEqual(['canc_support']);
    expect(rows[0].unitPrice).toBe(30);
  });
});

describe('row metadata', () => {
  // Breaks if invoiced/pending inverts, which drives the invoice-status filter
  // and would let an already-invoiced shift be invoiced twice.
  it('marks a row invoiced when an invoice number is supplied', () => {
    const rows = build({ invoiceNumber: 'IN-1042', invoicePdfLink: 'https://example.com/in-1042.pdf' });

    expect(rows[0].status).toBe('invoiced');
    expect(rows[0].invoiceNumber).toBe('IN-1042');
    expect(rows[0].fileUrl).toBe('https://example.com/in-1042.pdf');
  });

  // Breaks if the participant fallback chain reorders: the explicit name wins,
  // then the profile item, then the denormalised column on the master plan.
  it('falls back through participant name sources', () => {
    expect(build({ participantName: '' })[0].participant).toBe('');

    expect(build({
      participantName: null,
      participantProfileItem: { data: { 'Preferred Name': 'Sam' } },
    })[0].participant).toBe('Sam');

    expect(build({
      participantName: null,
      masterPlanItem: masterPlan(baseMasterData({ 'Participant Full Name': 'Samuel Rivers' })),
    })[0].participant).toBe('Samuel Rivers');
  });

  // Breaks if the telehealth mode stops reaching the claim type, which changes
  // which NDIA item the support is claimed against.
  it('derives THLT from a telehealth service delivery mode', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({
        'Service Delivery Mode': [{ id: 'sdm-1', name: 'Telehealth' }],
      })),
    });

    expect(rows[0].claimType).toBe('THLT');
  });

  it('builds a stable row id from the item id and the row code', () => {
    const rows = build({
      masterPlanItem: masterPlan(baseMasterData({ 'Allowances Amount($)': '10.00' })),
    });

    expect(rows.map((r) => r.id)).toEqual([`${ITEM_ID}:support`, `${ITEM_ID}:allowances`]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('survives a completely empty master plan item', () => {
    expect(buildNewNdisMasterPlanServiceRows({ masterPlanItem: null })).toEqual([]);
    expect(buildNewNdisMasterPlanServiceRows({})).toEqual([]);
  });
});
