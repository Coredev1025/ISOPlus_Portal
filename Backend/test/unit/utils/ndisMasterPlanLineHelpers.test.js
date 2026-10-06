import { describe, it, expect, vi } from 'vitest';
import {
  NDIS_AMOUNT_VALIDATION_MSG,
  formatNdisAmount,
  assertNdisAmountMatches,
  buildDirectSupportHourLine,
  buildDirectSupportNonHourLine,
  buildProviderTravelNonLabourLine,
  buildActivityBasedTransportLine,
  buildCentreCapitalCostsLine,
  buildLabourTravelTimeLine,
  buildAllowancesLine,
  buildNonFaceToFaceLine,
  buildDeliveredNdisMasterPlanLines,
  buildDirectSupportCancellationLine,
  buildProviderTravelCancellationLine,
  buildActivityTransportCancellationLine,
  buildCentreCapitalCancellationLine,
  buildCancelledNdisMasterPlanLines,
  buildNdisMasterPlanInvoiceLines,
  ndisLinesToXeroItems,
  ndisLinesToPdfOrders,
  sumNdisLineAmounts,
  buildParticipantProfileAddresses,
  resolveNdisParticipantContact,
  computeNdisServiceDate,
} from '../../../src/utils/ndisMasterPlanLineHelpers.js';

const TZ = 'Australia/Sydney';

// Attribute names exactly as ISO+ posts them in the master-plan webhook body.
const ATTR = {
  ACTUAL_START: 'Actual Shift Start Date and Time',
  ACTUAL_END: 'Actual Shift End Date and Time',
  ACTUAL_DURATION: 'Actual Shift Duration(Hr.)',
  SCHEDULED_DURATION: 'Scheduled Shift Duration(Hr.)',
  DIRECT_TIME_VALUE: 'Direct Support Value($) - Time Based Support',
  DIRECT_NON_TIME_VALUE: 'Direct Support Value($) - Non Time Based Support',
  DIRECT_NON_TIME_QTY: 'Quantity (Direct Support - Non Time Based Support)',
  PROVIDER_TRAVEL_AMOUNT: 'Provider Travel - Non-Labour Cost Amount($)',
  // NOTE the capitalisation: this module reads "Vehicle is Used", while
  // NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE is "vehicle is used".
  PROVIDER_TRAVEL_MILEAGE:
    'Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a Vehicle is Used.',
  PROVIDER_TRAVEL_OTHERS:
    'Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied.',
  ACTIVITY_AMOUNT: 'Activity Base Transport Amount($)',
  ACTIVITY_MILEAGE:
    'Activity Base Transport Mileage(Kms) as per the Service Plan, if a Vehicle is Used.',
  ACTIVITY_OTHERS:
    'Activity Base Transport Costs as per the Service Plan, if other costs are applied.',
  CENTRE_AMOUNT: 'Centre Capital Costs Amount($)',
  LABOUR_AMOUNT: 'Labour Travel Time Amount($)',
  LABOUR_MIN:
    'Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.',
  ALLOWANCES_AMOUNT: 'Allowances Amount($)',
  USED_ALLOWANCE: 'Used Allowance Amount($) as per the Service Plan',
  NON_FACE_AMOUNT: 'Non-Face-to-Face Amount($)',
  NON_FACE_HOURS:
    'Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)',
  CANCELLATION_FEE: 'Cancellation Fee($)',
};

function makeCtx(overrides = {}) {
  return {
    workspaceId: '55369',
    boardId: 'eNiJpH14PN3',
    itemId: 'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
    setIntegrationMessage: vi.fn().mockResolvedValue(undefined),
    timezone: TZ,
    groupSize: 1,
    servicePlanValues: {},
    invoiceValues: {},
    cancellationTypeValues: null,
    ...overrides,
  };
}

describe('formatNdisAmount', () => {
  it('rounds to two decimals and returns a fixed-width string', () => {
    expect(formatNdisAmount(135.117)).toBe('135.12');
    expect(formatNdisAmount(2.675)).toBe('2.68');
    expect(formatNdisAmount(7)).toBe('7.00');
    expect(formatNdisAmount('12.345')).toBe('12.35');
  });

  it('rounds 1.005 down to 1.00 — Math.round on a binary float, not decimal half-up', () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE-754, so the cent rounds down.
    // A decimal-correct implementation would return '1.01'.
    expect(formatNdisAmount(1.005)).toBe('1.00');
    expect(formatNdisAmount(1.015)).toBe('1.01');
  });

  it('keeps the sign on negatives', () => {
    expect(formatNdisAmount(-1.234)).toBe('-1.23');
    expect(formatNdisAmount(-1.235)).toBe('-1.24');
  });

  it('treats blank and null as zero but passes non-numeric values straight through', () => {
    expect(formatNdisAmount('')).toBe('0.00');
    expect(formatNdisAmount(null)).toBe('0.00');
    expect(formatNdisAmount('abc')).toBe('abc');
    expect(formatNdisAmount(undefined)).toBeUndefined();
  });
});

describe('assertNdisAmountMatches', () => {
  it('accepts values that agree only after cent rounding, without messaging', async () => {
    const ctx = makeCtx();
    await expect(assertNdisAmountMatches(ctx, 10.001, 10.004)).resolves.toBeUndefined();
    expect(ctx.setIntegrationMessage).not.toHaveBeenCalled();
  });

  it('awaits the integration message and throws when the cents differ', async () => {
    const ctx = makeCtx();
    await expect(assertNdisAmountMatches(ctx, 10.0, 10.01)).rejects.toThrow(
      NDIS_AMOUNT_VALIDATION_MSG,
    );
    expect(ctx.setIntegrationMessage).toHaveBeenCalledWith(
      '55369',
      'eNiJpH14PN3',
      'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
      NDIS_AMOUNT_VALIDATION_MSG,
    );
  });

  it('still sends the message when awaitIntegrationMessage is false', async () => {
    const ctx = makeCtx({ awaitIntegrationMessage: false });
    await expect(assertNdisAmountMatches(ctx, 1, 2)).rejects.toThrow(NDIS_AMOUNT_VALIDATION_MSG);
    expect(ctx.setIntegrationMessage).toHaveBeenCalledTimes(1);
  });
});

describe('buildDirectSupportHourLine', () => {
  it('returns null when the service plan unit is not Hour(H)', async () => {
    const ctx = makeCtx({
      servicePlanValues: { directSupportUnit: 'Each(E)', directSupportUnitPrice: 70.23 },
      invoiceValues: { [ATTR.DIRECT_TIME_VALUE]: 100 },
    });
    await expect(buildDirectSupportHourLine(ctx)).resolves.toBeNull();
  });

  it('divides the unit price by the group size and rounds the duration to one decimal', async () => {
    // 70.23 / 2 = 35.115 ; duration 2.46 -> 2.5 ; 2.5 * 35.115 = 87.7875 -> 87.79
    const ctx = makeCtx({
      groupSize: 2,
      servicePlanValues: {
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70.23,
        directSupportItemNumber: '01_011_0107_1_1',
        directSupportItemName: 'Assistance With Self-Care Activities',
      },
      invoiceValues: {
        [ATTR.ACTUAL_DURATION]: 2.46,
        [ATTR.DIRECT_TIME_VALUE]: 87.79,
      },
    });
    const line = await buildDirectSupportHourLine(ctx);
    expect(line).toEqual({
      desc: 'Assistance With Self-Care Activities - 01_011_0107_1_1 - Group Size: 2 - Unit: Hour(H)',
      unit: 'Hour(H)',
      qty: 2.5,
      unitPrice: 35.115,
      amount: '87.79',
    });
    expect(ctx.setIntegrationMessage).not.toHaveBeenCalled();
  });

  it('appends the shift window when both actual times are present', async () => {
    const ctx = makeCtx({
      servicePlanValues: {
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 10,
        directSupportItemName: 'Assistance With Self-Care Activities',
      },
      invoiceValues: {
        [ATTR.ACTUAL_START]: '2026-08-10T09:00:00.000+10:00',
        [ATTR.ACTUAL_END]: '2026-08-10T11:00:00.000+10:00',
        [ATTR.ACTUAL_DURATION]: 2,
        [ATTR.DIRECT_TIME_VALUE]: 20,
      },
    });
    const line = await buildDirectSupportHourLine(ctx);
    expect(line.desc).toMatch(
      /^Assistance With Self-Care Activities - from 10\/08\/2026, .+ to 10\/08\/2026, .+ - Unit: Hour\(H\)$/,
    );
    expect(line.amount).toBe('20.00');
  });

  it('returns null when no direct-support value has been calculated yet', async () => {
    const ctx = makeCtx({
      servicePlanValues: { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70.23 },
      invoiceValues: { [ATTR.ACTUAL_DURATION]: 2 },
    });
    await expect(buildDirectSupportHourLine(ctx)).resolves.toBeNull();
    expect(ctx.setIntegrationMessage).not.toHaveBeenCalled();
  });

  it('leaves a dangling separator when the item name is blank but the number is not', async () => {
    // Documented quirk: the empty-description fallback is checked after the
    // item-number append, so a nameless catalogue entry produces " - <number>".
    const ctx = makeCtx({
      servicePlanValues: {
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 10,
        directSupportItemNumber: '01_011_0107_1_1',
        directSupportItemName: '',
      },
      invoiceValues: { [ATTR.ACTUAL_DURATION]: 1, [ATTR.DIRECT_TIME_VALUE]: 10 },
    });
    const line = await buildDirectSupportHourLine(ctx);
    expect(line.desc).toBe(' - 01_011_0107_1_1 - Unit: Hour(H)');
  });

  it('falls back to a generic description when name and number are both blank', async () => {
    const ctx = makeCtx({
      servicePlanValues: { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 10 },
      invoiceValues: { [ATTR.ACTUAL_DURATION]: 1, [ATTR.DIRECT_TIME_VALUE]: 10 },
    });
    const line = await buildDirectSupportHourLine(ctx);
    expect(line.desc).toBe('Direct Support - Hour based - Unit: Hour(H)');
    expect(line.unit).toBe('Hour(H)');
  });

  it('throws the validation message when the stored value disagrees with duration x price', async () => {
    const ctx = makeCtx({
      servicePlanValues: { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70.23 },
      invoiceValues: { [ATTR.ACTUAL_DURATION]: 2, [ATTR.DIRECT_TIME_VALUE]: 100 },
    });
    await expect(buildDirectSupportHourLine(ctx)).rejects.toThrow(NDIS_AMOUNT_VALIDATION_MSG);
    expect(ctx.setIntegrationMessage).toHaveBeenCalledTimes(1);
  });

  it('scores a missing duration as zero quantity, which then fails the amount check', async () => {
    const ctx = makeCtx({
      servicePlanValues: { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70.23 },
      invoiceValues: { [ATTR.ACTUAL_DURATION]: 'n/a', [ATTR.DIRECT_TIME_VALUE]: 70.23 },
    });
    await expect(buildDirectSupportHourLine(ctx)).rejects.toThrow(NDIS_AMOUNT_VALIDATION_MSG);
  });
});

describe('buildDirectSupportNonHourLine', () => {
  it('returns null when the unit is Hour(H)', async () => {
    const ctx = makeCtx({
      servicePlanValues: { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70.23 },
      invoiceValues: { [ATTR.DIRECT_NON_TIME_VALUE]: 100 },
    });
    await expect(buildDirectSupportNonHourLine(ctx)).resolves.toBeNull();
  });

  it('multiplies quantity by the undivided unit price and repeats the unit in the description', async () => {
    // 3 * 21.4 = 64.20 ; group size is deliberately NOT applied on the non-hour path.
    const ctx = makeCtx({
      groupSize: 2,
      servicePlanValues: {
        directSupportUnit: 'Each(E)',
        directSupportUnitPrice: 21.4,
        directSupportItemNumber: '15_056_0128_1_3',
        directSupportItemName: 'Assessment Recommendation Therapy',
      },
      invoiceValues: {
        [ATTR.DIRECT_NON_TIME_QTY]: 3,
        [ATTR.DIRECT_NON_TIME_VALUE]: 64.2,
      },
    });
    const line = await buildDirectSupportNonHourLine(ctx);
    expect(line).toEqual({
      desc: 'Assessment Recommendation Therapy - 15_056_0128_1_3 - 3 Each(E) - Each(E)',
      unit: 'Each(E)',
      qty: 3,
      unitPrice: 21.4,
      amount: '64.20',
    });
  });

  it('falls back to a generic description and a blank unit when the service plan is bare', async () => {
    const ctx = makeCtx({
      servicePlanValues: {},
      invoiceValues: { [ATTR.DIRECT_NON_TIME_VALUE]: 0.01 },
    });
    await expect(buildDirectSupportNonHourLine(ctx)).rejects.toThrow(NDIS_AMOUNT_VALIDATION_MSG);
  });

  it('treats an unparseable quantity as zero', async () => {
    const ctx = makeCtx({
      servicePlanValues: { directSupportUnit: 'Each(E)', directSupportUnitPrice: 21.4 },
      invoiceValues: {
        [ATTR.DIRECT_NON_TIME_QTY]: 'three',
        [ATTR.DIRECT_NON_TIME_VALUE]: 64.2,
      },
    });
    // qty 0 -> computed amount 0.00, which cannot match the stored 64.20
    await expect(buildDirectSupportNonHourLine(ctx)).rejects.toThrow(NDIS_AMOUNT_VALIDATION_MSG);
  });
});

describe('buildProviderTravelNonLabourLine', () => {
  it('bills the stored amount as quantity at a unit price of 1', async () => {
    const ctx = makeCtx({
      servicePlanValues: {
        providerTravelItemName: 'Provider Travel - Non-Labour Costs',
        providerTravelItemNumber: '01_799_0107_1_1',
        nonLabourTravelUnit: 'Each(E)',
      },
      invoiceValues: {
        [ATTR.PROVIDER_TRAVEL_AMOUNT]: 43.1,
        [ATTR.PROVIDER_TRAVEL_MILEAGE]: 30,
        [ATTR.PROVIDER_TRAVEL_OTHERS]: 'Tolls',
      },
    });
    const line = await buildProviderTravelNonLabourLine(ctx);
    expect(line).toEqual({
      desc: 'Provider Travel - Non-Labour Costs - 01_799_0107_1_1 - 30km - Others: Tolls - Each(E)',
      unit: 'Each(E)',
      qty: 43.1,
      unitPrice: 1,
      amount: '43.10',
    });
  });

  it('ignores the NDIS_MASTERPLAN_ATTR spelling of the mileage key', async () => {
    // The constant is "...if a vehicle is used."; this module reads
    // "...if a Vehicle is Used.", so payloads keyed by the constant lose the km suffix.
    const ctx = makeCtx({
      servicePlanValues: { providerTravelItemName: 'Provider Travel - Non-Labour Costs' },
      invoiceValues: {
        [ATTR.PROVIDER_TRAVEL_AMOUNT]: 43.1,
        'Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a vehicle is used.': 30,
      },
    });
    const line = await buildProviderTravelNonLabourLine(ctx);
    expect(line.desc).toBe('Provider Travel - Non-Labour Costs');
  });

  it('returns null when nothing has been calculated', async () => {
    const ctx = makeCtx({ invoiceValues: { [ATTR.PROVIDER_TRAVEL_AMOUNT]: 0 } });
    await expect(buildProviderTravelNonLabourLine(ctx)).resolves.toBeNull();
  });

  it('falls back to a generic description', async () => {
    const ctx = makeCtx({ invoiceValues: { [ATTR.PROVIDER_TRAVEL_AMOUNT]: 5 } });
    const line = await buildProviderTravelNonLabourLine(ctx);
    expect(line.desc).toBe('Provider Travel - Non-Labour Cost Item');
    expect(line.unit).toBe(' ');
  });
});

describe('buildActivityBasedTransportLine', () => {
  it('bills the stored amount as quantity at a unit price of 1', async () => {
    const ctx = makeCtx({
      servicePlanValues: {
        activityBasedTransportItemName: 'Activity Based Transport',
        activityBasedTransportItemNumber: '02_051_0108_1_1',
        activityBasedTransportUnit: 'Each(E)',
      },
      invoiceValues: {
        [ATTR.ACTIVITY_AMOUNT]: 18.5,
        [ATTR.ACTIVITY_MILEAGE]: 12,
        [ATTR.ACTIVITY_OTHERS]: 'Parking',
      },
    });
    const line = await buildActivityBasedTransportLine(ctx);
    expect(line).toEqual({
      desc: 'Activity Based Transport - 02_051_0108_1_1 - 12km - Others: Parking - Each(E)',
      unit: 'Each(E)',
      qty: 18.5,
      unitPrice: 1,
      amount: '18.50',
    });
  });

  it('returns null when the amount is zero', async () => {
    const ctx = makeCtx({ invoiceValues: { [ATTR.ACTIVITY_AMOUNT]: 0 } });
    await expect(buildActivityBasedTransportLine(ctx)).resolves.toBeNull();
  });
});

describe('buildCentreCapitalCostsLine', () => {
  it('bills the rounded shift duration at the centre capital unit price', async () => {
    const ctx = makeCtx({
      servicePlanValues: {
        centreCapitalCostsUnitPrice: 15.5,
        centreCapitalCostsItemName: 'Centre Capital Cost',
        centreCapitalCostsItemNumber: '01_799_0115_1_1',
        centreCapitalCostsUnit: 'Hour(H)',
      },
      invoiceValues: { [ATTR.ACTUAL_DURATION]: 2, [ATTR.CENTRE_AMOUNT]: 31 },
    });
    const line = await buildCentreCapitalCostsLine(ctx);
    expect(line).toEqual({
      desc: 'Centre Capital Cost - 01_799_0115_1_1 - Hour(H)',
      unit: 'Hour(H)',
      qty: 2,
      unitPrice: 15.5,
      amount: '31.00',
    });
  });

  it('ignores the group size — centre capital is not divided per participant', async () => {
    const ctx = makeCtx({
      groupSize: 4,
      servicePlanValues: { centreCapitalCostsUnitPrice: 15.5 },
      invoiceValues: { [ATTR.ACTUAL_DURATION]: 2, [ATTR.CENTRE_AMOUNT]: 31 },
    });
    const line = await buildCentreCapitalCostsLine(ctx);
    expect(line.unitPrice).toBe(15.5);
    expect(line.amount).toBe('31.00');
  });

  it('throws when the stored amount disagrees with duration x price', async () => {
    const ctx = makeCtx({
      servicePlanValues: { centreCapitalCostsUnitPrice: 15.5 },
      invoiceValues: { [ATTR.ACTUAL_DURATION]: 2, [ATTR.CENTRE_AMOUNT]: 62 },
    });
    await expect(buildCentreCapitalCostsLine(ctx)).rejects.toThrow(NDIS_AMOUNT_VALIDATION_MSG);
  });
});

describe('buildLabourTravelTimeLine', () => {
  it('bills minutes directly against the agreed unit price — no divide by 60', async () => {
    // 45 minutes * 1.25 = 56.25. A per-hour reading would give 0.94.
    const ctx = makeCtx({
      servicePlanValues: { labourTravelTimeUnitPrice: 1.25, labourTravelTimeUnit: 'Hour(H)' },
      invoiceValues: { [ATTR.LABOUR_MIN]: 45, [ATTR.LABOUR_AMOUNT]: 56.25 },
    });
    const line = await buildLabourTravelTimeLine(ctx);
    expect(line).toEqual({
      desc: 'Provider Travel - Labour Travel Time Costs - Hour(H)',
      unit: 'Hour(H)',
      qty: 45,
      unitPrice: 1.25,
      amount: '56.25',
    });
  });

  it('returns null when no labour travel amount was calculated', async () => {
    const ctx = makeCtx({
      servicePlanValues: { labourTravelTimeUnitPrice: 1.25 },
      invoiceValues: { [ATTR.LABOUR_MIN]: 45 },
    });
    await expect(buildLabourTravelTimeLine(ctx)).resolves.toBeNull();
  });
});

describe('buildAllowancesLine', () => {
  it('bills a single unit priced at the used allowance amount', async () => {
    const ctx = makeCtx({
      servicePlanValues: { usedAllowanceUnit: 'Each(E)' },
      invoiceValues: {
        [ATTR.USED_ALLOWANCE]: 25.5,
        [ATTR.ALLOWANCES_AMOUNT]: 25.5,
        Allowances: 'Sleepover Allowance',
      },
    });
    const line = await buildAllowancesLine(ctx);
    expect(line).toEqual({
      desc: 'Allowances - Sleepover Allowance - Each(E)',
      unit: 'Each(E)',
      qty: 1,
      unitPrice: 25.5,
      amount: '25.50',
    });
  });

  it('interpolates the missing allowance type literally', async () => {
    const ctx = makeCtx({
      invoiceValues: { [ATTR.USED_ALLOWANCE]: 10, [ATTR.ALLOWANCES_AMOUNT]: 10 },
    });
    const line = await buildAllowancesLine(ctx);
    expect(line.desc).toBe('Allowances - undefined');
  });

  it('returns null when the allowances amount is zero', async () => {
    const ctx = makeCtx({
      invoiceValues: { [ATTR.USED_ALLOWANCE]: 10, [ATTR.ALLOWANCES_AMOUNT]: 0 },
    });
    await expect(buildAllowancesLine(ctx)).resolves.toBeNull();
  });
});

describe('buildNonFaceToFaceLine', () => {
  it('bills hours against the non-face-to-face unit price', async () => {
    const ctx = makeCtx({
      servicePlanValues: {
        nonFaceToFaceSupportUnitPrice: 60,
        nonFaceToFaceSupportUnit: 'Hour(H)',
      },
      invoiceValues: {
        [ATTR.NON_FACE_HOURS]: 0.5,
        [ATTR.NON_FACE_AMOUNT]: 30,
        'Non-Face-to-Face Supports': 'Case Note Writing',
      },
    });
    const line = await buildNonFaceToFaceLine(ctx);
    expect(line).toEqual({
      desc: 'Non-Face-to-Face Support - Case Note Writing - Hour(H)',
      unit: 'Hour(H)',
      qty: 0.5,
      unitPrice: 60,
      amount: '30.00',
    });
  });

  it('returns null when the amount is zero', async () => {
    const ctx = makeCtx({
      servicePlanValues: { nonFaceToFaceSupportUnitPrice: 60 },
      invoiceValues: { [ATTR.NON_FACE_HOURS]: 0.5, [ATTR.NON_FACE_AMOUNT]: 0 },
    });
    await expect(buildNonFaceToFaceLine(ctx)).resolves.toBeNull();
  });
});

describe('buildDeliveredNdisMasterPlanLines', () => {
  function deliveredCtx() {
    return makeCtx({
      servicePlanValues: {
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70.23,
        directSupportItemName: 'Assistance With Self-Care Activities',
        nonLabourTravelUnit: 'Each(E)',
        activityBasedTransportUnit: 'Each(E)',
        centreCapitalCostsUnitPrice: 15.5,
        centreCapitalCostsUnit: 'Hour(H)',
        labourTravelTimeUnitPrice: 1.25,
        labourTravelTimeUnit: 'Hour(H)',
        usedAllowanceUnit: 'Each(E)',
        nonFaceToFaceSupportUnitPrice: 60,
        nonFaceToFaceSupportUnit: 'Hour(H)',
      },
      invoiceValues: {
        [ATTR.ACTUAL_DURATION]: 2,
        [ATTR.DIRECT_TIME_VALUE]: 140.46,
        [ATTR.PROVIDER_TRAVEL_AMOUNT]: 43.1,
        [ATTR.ACTIVITY_AMOUNT]: 18.5,
        [ATTR.CENTRE_AMOUNT]: 31,
        [ATTR.LABOUR_MIN]: 45,
        [ATTR.LABOUR_AMOUNT]: 56.25,
        [ATTR.USED_ALLOWANCE]: 25.5,
        [ATTR.ALLOWANCES_AMOUNT]: 25.5,
        Allowances: 'Sleepover Allowance',
        [ATTR.NON_FACE_HOURS]: 0.5,
        [ATTR.NON_FACE_AMOUNT]: 30,
        'Non-Face-to-Face Supports': 'Case Note Writing',
      },
    });
  }

  it('emits every applicable line in builder order', async () => {
    const lines = await buildDeliveredNdisMasterPlanLines(deliveredCtx());
    expect(lines.map((l) => l.amount)).toEqual([
      '140.46', // direct support, hour based
      '43.10', // provider travel non-labour
      '18.50', // activity based transport
      '31.00', // centre capital costs
      '56.25', // labour travel time
      '25.50', // allowances
      '30.00', // non-face-to-face
    ]);
    expect(lines[0].desc).toBe(
      'Assistance With Self-Care Activities - Unit: Hour(H)',
    );
    expect(lines[6].desc).toBe('Non-Face-to-Face Support - Case Note Writing - Hour(H)');
  });

  it('never emits both direct-support lines for the same shift', async () => {
    const ctx = deliveredCtx();
    ctx.invoiceValues[ATTR.DIRECT_NON_TIME_QTY] = 3;
    ctx.invoiceValues[ATTR.DIRECT_NON_TIME_VALUE] = 64.2;
    const lines = await buildDeliveredNdisMasterPlanLines(ctx);
    expect(lines.filter((l) => l.desc.includes('Assistance With Self-Care'))).toHaveLength(1);
    expect(lines).toHaveLength(7);
  });

  it('skips the lines whose amounts are still zero', async () => {
    const ctx = makeCtx({
      servicePlanValues: { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70.23 },
      invoiceValues: { [ATTR.ACTUAL_DURATION]: 2, [ATTR.DIRECT_TIME_VALUE]: 140.46 },
    });
    const lines = await buildDeliveredNdisMasterPlanLines(ctx);
    expect(lines).toHaveLength(1);
  });

  it('returns an empty list when nothing has been calculated', async () => {
    const lines = await buildDeliveredNdisMasterPlanLines(makeCtx());
    expect(lines).toEqual([]);
  });
});

describe('buildDirectSupportCancellationLine', () => {
  const CANC_TYPE = { billableToClient: 90 };

  it('returns null unless short-notice cancellations are enabled on the plan', () => {
    const ctx = makeCtx({
      cancellationTypeValues: CANC_TYPE,
      servicePlanValues: {
        directSupportShortNoticeCancellations: 'N',
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70.23,
      },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 3, [ATTR.CANCELLATION_FEE]: 94.8 },
    });
    expect(buildDirectSupportCancellationLine(ctx)).toBeNull();
  });

  it('applies the billable percentage to the group-divided hourly rate', () => {
    // 70.23 / 2 = 35.115 ; 35.115 * 90% = 31.6035 -> 31.60 ; 3.0 * 31.60 = 94.80
    const ctx = makeCtx({
      groupSize: 2,
      cancellationTypeValues: CANC_TYPE,
      servicePlanValues: {
        directSupportShortNoticeCancellations: 'Y',
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70.23,
        directSupportItemName: 'Assistance With Self-Care Activities',
        directSupportItemNumber: '01_011_0107_1_1',
      },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 3, [ATTR.CANCELLATION_FEE]: 94.8 },
    });
    const line = buildDirectSupportCancellationLine(ctx);
    expect(line).toEqual({
      desc: 'Cancellation Fee - Assistance With Self-Care Activities - 01_011_0107_1_1 - 90% - Group Size: 2 - Unit: Hour(H)',
      unit: 'Hour(H)',
      // the scheduled duration leaks out as the string toFixed(1) produced
      qty: '3.0',
      unitPrice: 31.6,
      amount: '94.80',
      cancellationAmount: 94.8,
    });
  });

  it('uses the non-time quantity and the undivided rate when the unit is not hourly', () => {
    // 21.40 * 50% = 10.70 ; qty 2 -> 21.40
    const ctx = makeCtx({
      groupSize: 2,
      cancellationTypeValues: { billableToClient: 50 },
      servicePlanValues: {
        directSupportShortNoticeCancellations: 'Y',
        directSupportUnit: 'Each(E)',
        directSupportUnitPrice: 21.4,
      },
      invoiceValues: {
        [ATTR.SCHEDULED_DURATION]: 3,
        [ATTR.DIRECT_NON_TIME_QTY]: 2,
        [ATTR.CANCELLATION_FEE]: 21.4,
      },
    });
    const line = buildDirectSupportCancellationLine(ctx);
    expect(line.qty).toBe(2);
    expect(line.unitPrice).toBe(10.7);
    expect(line.amount).toBe('21.40');
    expect(line.cancellationAmount).toBe(21.4);
  });

  it('returns null before computing anything when no cancellation fee is stored', () => {
    const ctx = makeCtx({
      cancellationTypeValues: CANC_TYPE,
      servicePlanValues: {
        directSupportShortNoticeCancellations: 'Y',
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70.23,
      },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 3, [ATTR.CANCELLATION_FEE]: 0 },
    });
    expect(buildDirectSupportCancellationLine(ctx)).toBeNull();
  });

  it('treats a missing cancellation type percentage as zero', () => {
    const ctx = makeCtx({
      cancellationTypeValues: {},
      servicePlanValues: {
        directSupportShortNoticeCancellations: 'Y',
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70.23,
      },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 3, [ATTR.CANCELLATION_FEE]: 94.8 },
    });
    const line = buildDirectSupportCancellationLine(ctx);
    expect(line.unitPrice).toBe(0);
    expect(line.amount).toBe('0.00');
    expect(line.desc).toContain(' - 0%');
  });
});

describe('buildProviderTravelCancellationLine', () => {
  it('applies the billable percentage to the non-labour travel rate', () => {
    // 1.02 * 90% = 0.918 -> 0.92 ; 3.0 * 0.92 = 2.76
    const ctx = makeCtx({
      groupSize: 2,
      cancellationTypeValues: { billableToClient: 90 },
      servicePlanValues: {
        providerTravelShortNoticeCancellations: 'Y',
        nonLabourTravelUnitPrice: 1.02,
        nonLabourTravelUnit: 'Each(E)',
        providerTravelItemName: 'Provider Travel - Non-Labour Costs',
      },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 3 },
    });
    const line = buildProviderTravelCancellationLine(ctx);
    expect(line).toEqual({
      // group size is hard-coded to 1 here, so no Group Size suffix
      desc: 'Cancellation Fee - Provider Travel - Non-Labour Costs - 90% - Each(E)',
      unit: 'Each(E)',
      qty: '3.0',
      unitPrice: 0.92,
      amount: '2.76',
      cancellationAmount: 2.76,
    });
  });

  it('returns null when the flag is off', () => {
    const ctx = makeCtx({
      cancellationTypeValues: { billableToClient: 90 },
      servicePlanValues: { nonLabourTravelUnitPrice: 1.02 },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 3 },
    });
    expect(buildProviderTravelCancellationLine(ctx)).toBeNull();
  });

  it('returns null when the scheduled duration is zero', () => {
    const ctx = makeCtx({
      cancellationTypeValues: { billableToClient: 90 },
      servicePlanValues: {
        providerTravelShortNoticeCancellations: 'Y',
        nonLabourTravelUnitPrice: 1.02,
      },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 0 },
    });
    expect(buildProviderTravelCancellationLine(ctx)).toBeNull();
  });
});

describe('buildActivityTransportCancellationLine', () => {
  it('applies the billable percentage to the activity transport rate', () => {
    // 4.00 * 75% = 3.00 ; 2.0 * 3.00 = 6.00
    const ctx = makeCtx({
      cancellationTypeValues: { billableToClient: 75 },
      servicePlanValues: {
        activityBasedTransportShortNoticeCancellations: 'Y',
        activityBasedTransportUnitPrice: 4,
        activityBasedTransportUnit: 'Each(E)',
        activityBasedTransportItemNumber: '02_051_0108_1_1',
      },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 2 },
    });
    const line = buildActivityTransportCancellationLine(ctx);
    expect(line.desc).toBe('Cancellation Fee - 02_051_0108_1_1 - 75% - Each(E)');
    expect(line.unitPrice).toBe(3);
    expect(line.amount).toBe('6.00');
    expect(line.cancellationAmount).toBe(6);
  });

  it('returns null when the flag is off', () => {
    const ctx = makeCtx({
      cancellationTypeValues: { billableToClient: 75 },
      servicePlanValues: { activityBasedTransportUnitPrice: 4 },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 2 },
    });
    expect(buildActivityTransportCancellationLine(ctx)).toBeNull();
  });
});

describe('buildCentreCapitalCancellationLine', () => {
  it('applies the billable percentage to the centre capital rate', () => {
    // 15.50 * 60% = 9.30 ; 2.0 * 9.30 = 18.60
    const ctx = makeCtx({
      cancellationTypeValues: { billableToClient: 60 },
      servicePlanValues: {
        centreCapitalCostsShortNoticeCancellations: 'Y',
        centreCapitalCostsUnitPrice: 15.5,
        centreCapitalCostsUnit: 'Hour(H)',
        centreCapitalCostsItemName: 'Centre Capital Cost',
      },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 2 },
    });
    const line = buildCentreCapitalCancellationLine(ctx);
    expect(line.desc).toBe('Cancellation Fee - Centre Capital Cost - 60% - Hour(H)');
    expect(line.unitPrice).toBe(9.3);
    expect(line.amount).toBe('18.60');
  });

  it('returns null when the billable percentage is zero', () => {
    const ctx = makeCtx({
      cancellationTypeValues: { billableToClient: 0 },
      servicePlanValues: {
        centreCapitalCostsShortNoticeCancellations: 'Y',
        centreCapitalCostsUnitPrice: 15.5,
      },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 2 },
    });
    expect(buildCentreCapitalCancellationLine(ctx)).toBeNull();
  });

  it('returns null when there is no centre capital rate at all', () => {
    const ctx = makeCtx({
      cancellationTypeValues: { billableToClient: 60 },
      servicePlanValues: { centreCapitalCostsShortNoticeCancellations: 'Y' },
      invoiceValues: { [ATTR.SCHEDULED_DURATION]: 2 },
    });
    expect(buildCentreCapitalCancellationLine(ctx)).toBeNull();
  });
});

describe('buildCancelledNdisMasterPlanLines', () => {
  function cancelledCtx(overrides = {}) {
    return makeCtx({
      groupSize: 2,
      cancellationTypeValues: { billableToClient: 90 },
      servicePlanValues: {
        directSupportShortNoticeCancellations: 'Y',
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70.23,
        providerTravelShortNoticeCancellations: 'Y',
        nonLabourTravelUnitPrice: 1.02,
        nonLabourTravelUnit: 'Each(E)',
      },
      invoiceValues: {
        [ATTR.SCHEDULED_DURATION]: 3,
        // 94.80 (direct support) + 2.76 (provider travel)
        [ATTR.CANCELLATION_FEE]: 97.56,
      },
      ...overrides,
    });
  }

  it('messages and throws when no cancellation type is linked', async () => {
    const ctx = cancelledCtx({ cancellationTypeValues: null });
    await expect(buildCancelledNdisMasterPlanLines(ctx)).rejects.toThrow(
      'Cancellation Type Item not found',
    );
    expect(ctx.setIntegrationMessage).toHaveBeenCalledWith(
      '55369',
      'eNiJpH14PN3',
      'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce',
      'Cancellation Type Item not found',
    );
  });

  it('sends the message without awaiting when awaitIntegrationMessage is false', async () => {
    const ctx = cancelledCtx({ cancellationTypeValues: null, awaitIntegrationMessage: false });
    await expect(buildCancelledNdisMasterPlanLines(ctx)).rejects.toThrow(
      'Cancellation Type Item not found',
    );
    expect(ctx.setIntegrationMessage).toHaveBeenCalledTimes(1);
  });

  it('returns each enabled component and reconciles their total against the stored fee', async () => {
    const ctx = cancelledCtx();
    const lines = await buildCancelledNdisMasterPlanLines(ctx);
    expect(lines.map((l) => l.cancellationAmount)).toEqual([94.8, 2.76]);
    expect(ctx.setIntegrationMessage).not.toHaveBeenCalled();
  });

  it('throws when the components do not add up to the stored fee', async () => {
    const ctx = cancelledCtx();
    ctx.invoiceValues[ATTR.CANCELLATION_FEE] = 94.8;
    await expect(buildCancelledNdisMasterPlanLines(ctx)).rejects.toThrow(
      NDIS_AMOUNT_VALIDATION_MSG,
    );
  });
});

describe('buildNdisMasterPlanInvoiceLines', () => {
  it('takes the delivered path for any status other than Cancelled', async () => {
    const ctx = makeCtx({
      servicePlanValues: { directSupportUnit: 'Hour(H)', directSupportUnitPrice: 70.23 },
      invoiceValues: {
        'Job Status': 'Completed',
        [ATTR.ACTUAL_DURATION]: 2,
        [ATTR.DIRECT_TIME_VALUE]: 140.46,
      },
    });
    const lines = await buildNdisMasterPlanInvoiceLines(ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe('140.46');
    expect(lines[0].cancellationAmount).toBeUndefined();
  });

  it('takes the cancellation path for Cancelled', async () => {
    const ctx = makeCtx({
      cancellationTypeValues: { billableToClient: 90 },
      servicePlanValues: {
        directSupportShortNoticeCancellations: 'Y',
        directSupportUnit: 'Hour(H)',
        directSupportUnitPrice: 70.23,
      },
      invoiceValues: {
        'Job Status': 'Cancelled',
        [ATTR.SCHEDULED_DURATION]: 3,
        // 70.23 * 90% = 63.207 -> 63.21 ; 3.0 * 63.21 = 189.63
        [ATTR.CANCELLATION_FEE]: 189.63,
        [ATTR.ACTUAL_DURATION]: 2,
        [ATTR.DIRECT_TIME_VALUE]: 140.46,
      },
    });
    const lines = await buildNdisMasterPlanInvoiceLines(ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0].cancellationAmount).toBe(189.63);
  });
});

describe('ndisLinesToXeroItems', () => {
  const lines = [
    { desc: 'Direct Support', unit: 'Hour(H)', qty: 2.5, unitPrice: 35.115, amount: '87.79' },
    { desc: 'Provider Travel', unit: 'Each(E)', qty: 43.1, unitPrice: 1, amount: '43.10' },
  ];

  it('appends the service date and formats quantity but leaves the unit amount raw', () => {
    expect(ndisLinesToXeroItems(lines, {
      gstType: 'EXEMPTOUTPUT',
      salesAccountCode: '200',
      serviceDate: '10/08/2026',
    })).toEqual([
      {
        description: 'Direct Support - 10/08/2026',
        quantity: '2.50',
        unitAmount: 35.115,
        taxType: 'EXEMPTOUTPUT',
        accountCode: '200',
      },
      {
        description: 'Provider Travel - 10/08/2026',
        quantity: '43.10',
        unitAmount: 1,
        taxType: 'EXEMPTOUTPUT',
        accountCode: '200',
      },
    ]);
  });

  it('leaves the description alone when there is no service date', () => {
    const items = ndisLinesToXeroItems(lines, { gstType: 'NONE', salesAccountCode: '200' });
    expect(items[0].description).toBe('Direct Support');
  });

  it('honours an injected formatter for the quantity column', () => {
    const items = ndisLinesToXeroItems(lines, {
      gstType: 'NONE',
      salesAccountCode: '200',
      formatValue: (v) => `<${v}>`,
    });
    expect(items[0].quantity).toBe('<2.5>');
  });
});

describe('ndisLinesToPdfOrders', () => {
  it('emits the seven PDF table columns in order', () => {
    const orders = ndisLinesToPdfOrders(
      [{ desc: 'Direct Support', unit: 'Hour(H)', qty: 2.5, unitPrice: 35.115, amount: '87.79' }],
      { gstLabel: '0%', serviceDate: '10/08/2026' },
    );
    expect(orders).toEqual([
      ['10/08/2026', 'Direct Support', 'Hour(H)', '2.50', '35.12', '0%', '87.79'],
    ]);
  });

  it('substitutes a blank cell when no service date is known', () => {
    const orders = ndisLinesToPdfOrders(
      [{ desc: 'Direct Support', unit: 'Hour(H)', qty: 1, unitPrice: 1, amount: '1.00' }],
      { gstLabel: '0%', serviceDate: '' },
    );
    expect(orders[0][0]).toBe(' ');
  });
});

describe('sumNdisLineAmounts', () => {
  it('adds the string amounts numerically', () => {
    expect(sumNdisLineAmounts([{ amount: '87.79' }, { amount: '43.10' }, { amount: '18.50' }]))
      .toBeCloseTo(149.39, 10);
  });

  it('returns zero for an empty invoice', () => {
    expect(sumNdisLineAmounts([])).toBe(0);
  });

  it('subtracts negative amounts rather than ignoring them', () => {
    expect(sumNdisLineAmounts([{ amount: '100.00' }, { amount: '-25.50' }])).toBe(74.5);
  });
});

describe('buildParticipantProfileAddresses', () => {
  it('mirrors the same address into a POBOX and a STREET entry', () => {
    expect(buildParticipantProfileAddresses({
      address: '2 Sample Road',
      suburb: 'Testville',
      state: 'NSW',
      postcode: 2000,
    })).toEqual([
      {
        addressType: 'POBOX',
        addressLine1: '2 Sample Road',
        city: 'Testville',
        region: 'NSW',
        postalCode: '2000',
      },
      {
        addressType: 'STREET',
        addressLine1: '2 Sample Road',
        city: 'Testville',
        region: 'NSW',
        postalCode: '2000',
      },
    ]);
  });

  it('substitutes a single space for every missing field', () => {
    const [pobox] = buildParticipantProfileAddresses({});
    expect(pobox).toEqual({
      addressType: 'POBOX',
      addressLine1: ' ',
      city: ' ',
      region: ' ',
      postalCode: ' ',
    });
  });
});

describe('resolveNdisParticipantContact', () => {
  function deps(overrides = {}) {
    return {
      getContactByEmail: vi.fn().mockResolvedValue(null),
      createOrUpdateContact: vi.fn().mockResolvedValue({ contactID: 'new-contact' }),
      setIntegrationMessage: vi.fn().mockResolvedValue(undefined),
      workspaceId: '55369',
      boardId: 'eNiJpH14PN3',
      itemId: 'item-1',
      ...overrides,
    };
  }

  it('creates the contact and derives the name from first + last when there is no full name', async () => {
    const d = deps({
      participantProfileValues: {
        firstName: '  Jordan ',
        lastName: 'Fixture ',
        email: 'jordan@example.test',
        address: '2 Sample Road',
        suburb: 'Testville',
        state: 'NSW',
        postcode: '2000',
      },
    });
    const contact = await resolveNdisParticipantContact(d);
    expect(contact).toEqual({ contactID: 'new-contact' });
    expect(d.setIntegrationMessage).toHaveBeenCalledWith(
      '55369',
      'eNiJpH14PN3',
      'item-1',
      'The contact does not exist in Xero, creating...',
    );
    expect(d.createOrUpdateContact).toHaveBeenCalledWith({
      name: 'Jordan Fixture',
      firstName: 'Jordan',
      lastName: 'Fixture',
      emailAddress: 'jordan@example.test',
      addresses: [
        {
          addressType: 'POBOX',
          addressLine1: '2 Sample Road',
          city: 'Testville',
          region: 'NSW',
          postalCode: '2000',
        },
        {
          addressType: 'STREET',
          addressLine1: '2 Sample Road',
          city: 'Testville',
          region: 'NSW',
          postalCode: '2000',
        },
      ],
    });
  });

  it('prefers the profile full name over first + last', async () => {
    const d = deps({
      participantProfileValues: {
        fullName: 'Jordan A. Fixture',
        firstName: 'Jordan',
        lastName: 'Fixture',
        email: 'jordan@example.test',
      },
    });
    await resolveNdisParticipantContact(d);
    expect(d.createOrUpdateContact.mock.calls[0][0].name).toBe('Jordan A. Fixture');
  });

  it('refuses to create a contact without both names', async () => {
    const d = deps({
      participantProfileValues: { firstName: 'Jordan', email: 'jordan@example.test' },
    });
    await expect(resolveNdisParticipantContact(d)).rejects.toThrow(
      /First name and last name are required/,
    );
    expect(d.createOrUpdateContact).not.toHaveBeenCalled();
  });

  it('leaves an existing contact untouched when Xero is at least as fresh as ISO+', async () => {
    const existing = { contactID: 'c-1', updatedDateUTC: '2026-08-10T00:00:00.000Z' };
    const d = deps({
      getContactByEmail: vi.fn().mockResolvedValue(existing),
      participantProfileValues: {
        firstName: 'Jordan',
        lastName: 'Fixture',
        email: 'jordan@example.test',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    });
    await expect(resolveNdisParticipantContact(d)).resolves.toBe(existing);
    expect(d.createOrUpdateContact).not.toHaveBeenCalled();
    expect(d.setIntegrationMessage).not.toHaveBeenCalled();
  });

  it('pushes an update carrying the contactID when ISO+ is newer', async () => {
    const existing = { contactID: 'c-1', updatedDateUTC: '2026-08-01T00:00:00.000Z' };
    const d = deps({
      getContactByEmail: vi.fn().mockResolvedValue(existing),
      createOrUpdateContact: vi.fn().mockResolvedValue({ contactID: 'c-1', updated: true }),
      participantProfileValues: {
        firstName: 'Jordan',
        lastName: 'Fixture',
        email: 'jordan@example.test',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    });
    const contact = await resolveNdisParticipantContact(d);
    expect(contact).toEqual({ contactID: 'c-1', updated: true });
    expect(d.createOrUpdateContact.mock.calls[0][0].contactID).toBe('c-1');
  });

  it('skips the update when the profile is newer but a name is missing', async () => {
    const existing = { contactID: 'c-1', updatedDateUTC: '2026-08-01T00:00:00.000Z' };
    const d = deps({
      getContactByEmail: vi.fn().mockResolvedValue(existing),
      participantProfileValues: {
        firstName: 'Jordan',
        lastName: '   ',
        email: 'jordan@example.test',
        updatedAt: '2026-08-09T00:00:00.000Z',
      },
    });
    await expect(resolveNdisParticipantContact(d)).resolves.toBe(existing);
    expect(d.createOrUpdateContact).not.toHaveBeenCalled();
  });

  it('updates when either timestamp is unparseable, because NaN >= NaN is false', async () => {
    const existing = { contactID: 'c-1', updatedDateUTC: 'not-a-date' };
    const d = deps({
      getContactByEmail: vi.fn().mockResolvedValue(existing),
      participantProfileValues: {
        firstName: 'Jordan',
        lastName: 'Fixture',
        email: 'jordan@example.test',
        updatedAt: 'also-not-a-date',
      },
    });
    await resolveNdisParticipantContact(d);
    expect(d.createOrUpdateContact).toHaveBeenCalledTimes(1);
  });
});

describe('computeNdisServiceDate', () => {
  const ACTUAL = '2026-08-10T09:00:00.000+10:00';
  const SCHEDULED = '2026-08-09T09:00:00.000+10:00';

  it('prefers the actual start for a delivered shift', () => {
    expect(computeNdisServiceDate({
      'Job Status': 'Completed',
      'Actual Shift Start Date and Time': ACTUAL,
      'Scheduled Shift Start Date & Time': SCHEDULED,
    }, TZ)).toBe('10/08/2026');
  });

  it('falls back to the scheduled start when the shift never started', () => {
    expect(computeNdisServiceDate({
      'Job Status': 'Completed',
      'Scheduled Shift Start Date & Time': SCHEDULED,
    }, TZ)).toBe('09/08/2026');
  });

  it('prefers the scheduled start for a cancelled shift', () => {
    expect(computeNdisServiceDate({
      'Job Status': 'Cancelled',
      'Actual Shift Start Date and Time': ACTUAL,
      'Scheduled Shift Start Date & Time': SCHEDULED,
    }, TZ)).toBe('09/08/2026');
  });

  it('falls back to the actual start for a cancelled shift with no schedule', () => {
    expect(computeNdisServiceDate({
      'Job Status': 'Cancelled',
      'Actual Shift Start Date and Time': ACTUAL,
    }, TZ)).toBe('10/08/2026');
  });

  it('accepts the "and" spelling of both attribute names', () => {
    expect(computeNdisServiceDate({
      'Job Status': 'Cancelled',
      'Scheduled Shift Start Date and Time': SCHEDULED,
    }, TZ)).toBe('09/08/2026');
    expect(computeNdisServiceDate({
      'Job Status': 'Completed',
      'Actual Shift Start Date & Time': ACTUAL,
    }, TZ)).toBe('10/08/2026');
  });

  it('renders the date in the requested timezone, not the host one', () => {
    // 09:00 Sydney on 10 Aug is 23:00 UTC on 9 Aug.
    expect(computeNdisServiceDate({
      'Job Status': 'Completed',
      'Actual Shift Start Date and Time': ACTUAL,
    }, 'UTC')).toBe('09/08/2026');
  });

  it('returns an empty string when no start time is present at all', () => {
    expect(computeNdisServiceDate({ 'Job Status': 'Completed' }, TZ)).toBe('');
  });
});
