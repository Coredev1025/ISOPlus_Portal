import { describe, it, expect, vi } from 'vitest';
import {
  NDIS_MASTERPLAN_ATTR,
  NDIS_SERVICEPLAN_ATTR,
  NDIS_SUPPORT_CATALOGUE_ATTR,
  NDIS_CANCELLATION_TYPE_ATTR,
  isUuidLike,
  extractRefId,
  extractAllRefIds,
  formatLabelValue,
  getValue,
  getValueMulti,
  parseNumberValue,
  computeProviderTravelNonLabourAmount,
  computeActivityBaseTransportAmount,
  computeLabourTravelTimeAmount,
  round1,
  isNonZero,
  dateOnlyToISOWithOffset,
  getDateOnlyIso,
  formatDdMmYyyy,
  formatDateInValueZone,
  formatDateTimeInValueZone,
  hoursToHhhMm,
  minutesToHhhMm,
  formatDurationHhhMm,
  sanitizeDigits,
  getSupportItemNumber,
  getSupportItemName,
  getShortNoticeCancellationsFlag,
  getParticipantDisplayName,
  getParticipantNdisNumber,
  mapCancellationReasonCode,
  formatHoursHhhMmForCsv,
  isHourBasedNdisClaimRow,
  mapNdisClaimCsvQuantityAndHours,
  resolveRefItemDisplayName,
  resolveCancellationReasonLabel,
  resolveNdisSupportDeliveredDates,
  isCancellationClaimRow,
  isTelehealthServiceMode,
  resolveNdisClaimType,
  isHourUnitLabel,
  isCompletedShiftStatus,
  isCancelledShiftStatus,
  buildServiceItemDescription,
  collectNdisSupportCatalogueRefIds,
  buildNdisSupportCatalogueForServicePlan,
  buildNdisMasterPlanServiceRows,
  buildLegacyNdisMasterPlanServiceRows,
} from '../../../src/utils/ndisServiceRecords.js';

/*
 * ndisServiceRecords.js is the shared vocabulary of NDIS invoicing: the ISO+
 * attribute-name constants plus the parsing/formatting primitives every other
 * NDIS helper builds on. A silent change here (a rounding mode, a claim-type
 * suffix, an attribute-name typo) reaches the generated invoice and the NDIA
 * claim CSV, so each test below pins a hand-derived literal.
 *
 * Fixture shape mirrors Mongo: an item is `{ itemId, boardId, data }` with
 * `data` keyed by the ISO+ attribute name; a reference value is an array of
 * `{ id, name }` objects.
 */

const UUID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-2222-4111-8111-bbbbbbbbbbbb';
const TZ = 'Australia/Sydney';

const item = (data, extra = {}) => ({ itemId: 'mp-1', boardId: 'board-1', data, ...extra });

describe('attribute-name constants', () => {
  // Breaks if an attribute name is retyped: ISO+ keys its webhook payload and
  // its stored item data by these exact strings, so a changed character means
  // the value silently reads as undefined and the amount becomes 0.
  it('keeps the exact ISO+ attribute names used by the master plan', () => {
    expect(NDIS_MASTERPLAN_ATTR.ACTUAL_DURATION_HR).toBe('Actual Shift Duration(Hr.)');
    expect(NDIS_MASTERPLAN_ATTR.SCHEDULED_DURATION_HR).toBe('Scheduled Shift Duration(Hr.)');
    expect(NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME)
      .toBe('Direct Support Value($) - Time Based Support');
    expect(NDIS_MASTERPLAN_ATTR.SUPPORT_VALUE).toBe('Support Value($)');
    expect(NDIS_MASTERPLAN_ATTR.QUANTITY_NON_TIME_BASED).toBe('Quantity (Non-Time-Based Support)');
    expect(NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_MIN)
      .toBe('Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.');
  });

  it('keeps the exact ISO+ attribute names used by the service plan', () => {
    expect(NDIS_SERVICEPLAN_ATTR.ITEM_DIRECT_SUPPORT).toBe('Direct Support Item Number');
    expect(NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT).toBe('Support Item Number');
    expect(NDIS_SERVICEPLAN_ATTR.PRICE_SUPPORT).toBe('Agreed Unit Price for Support ($)');
    expect(NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION).toBe('Cancellation Item Number');
    expect(NDIS_SUPPORT_CATALOGUE_ATTR.SHORT_NOTICE_CANCELLATIONS).toBe('Short Notice Cancellations');
    expect(NDIS_CANCELLATION_TYPE_ATTR.BILLABLE_TO_CLIENT_PCT).toBe('Billable to Client %');
  });
});

describe('isUuidLike', () => {
  // Breaks if the guard is loosened: non-uuid label text would then be treated
  // as a reference id and looked up (returning nothing) instead of displayed.
  it('accepts a canonical uuid in either case and rejects near-misses', () => {
    expect(isUuidLike(UUID_A)).toBe(true);
    expect(isUuidLike(UUID_A.toUpperCase())).toBe(true);
    expect(isUuidLike('aaaaaaaa-1111-4111-8111-aaaaaaaaaaa')).toBe(false); // 11 trailing chars
    expect(isUuidLike(`${UUID_A} `)).toBe(false);
    expect(isUuidLike('Assistance With Self-Care')).toBe(false);
    expect(isUuidLike(null)).toBe(false);
    expect(isUuidLike(undefined)).toBe(false);
    expect(isUuidLike(12345)).toBe(false);
  });
});

describe('extractRefId / extractAllRefIds', () => {
  // Breaks if the array-first rule is dropped — ISO+ always sends references as
  // arrays, so reading the object directly would return null and lose the link.
  it('takes the first id from an ISO+ reference array', () => {
    expect(extractRefId([{ id: UUID_A, name: 'A' }, { id: UUID_B, name: 'B' }])).toBe(UUID_A);
    expect(extractAllRefIds([{ id: UUID_A }, { id: UUID_B }])).toEqual([UUID_A, UUID_B]);
  });

  it('handles bare strings, single objects and empty values', () => {
    expect(extractRefId(UUID_A)).toBe(UUID_A);
    expect(extractRefId({ id: UUID_B })).toBe(UUID_B);
    expect(extractRefId([UUID_A])).toBe(UUID_A);
    expect(extractRefId(null)).toBeNull();
    expect(extractRefId('')).toBeNull();
    // An empty array is truthy, so it falls through to String([]) === ''.
    // Callers guard with `if (id && isUuidLike(id))`, so '' is inert.
    expect(extractRefId([])).toBe('');
    expect(extractAllRefIds(null)).toEqual([]);
    expect(extractAllRefIds([])).toEqual([]);
    expect(extractAllRefIds(UUID_A)).toEqual([UUID_A]);
    expect(extractAllRefIds({ id: UUID_A })).toEqual([UUID_A]);
  });

  // Breaks if the numeric coercion is removed: ISO+ occasionally sends numeric
  // ids and String(number) is what keeps the map lookup keyed consistently.
  it('stringifies a numeric id', () => {
    expect(extractRefId(4321)).toBe('4321');
    expect(extractAllRefIds([4321, 8765])).toEqual(['4321', '8765']);
  });
});

describe('formatLabelValue', () => {
  // Breaks if the key priority changes: `name` must win over `id`, otherwise a
  // uuid is printed on the invoice line where a label belongs.
  it('prefers name, then label, then value, then id', () => {
    expect(formatLabelValue({ name: 'N', label: 'L', value: 'V', id: UUID_A })).toBe('N');
    expect(formatLabelValue({ label: 'L', value: 'V', id: UUID_A })).toBe('L');
    expect(formatLabelValue({ value: 'V', id: UUID_A })).toBe('V');
    expect(formatLabelValue({ id: UUID_A })).toBe(UUID_A);
  });

  it('joins array members with a comma and drops empty ones', () => {
    expect(formatLabelValue([{ name: 'Sleepover' }, { name: 'Travel' }])).toBe('Sleepover, Travel');
    expect(formatLabelValue([{ name: 'Sleepover' }, null, ''])).toBe('Sleepover');
  });

  it('returns an empty string for null and undefined but keeps 0 and false', () => {
    expect(formatLabelValue(null)).toBe('');
    expect(formatLabelValue(undefined)).toBe('');
    expect(formatLabelValue(0)).toBe('0');
    expect(formatLabelValue(false)).toBe('false');
  });
});

describe('getValue / getValueMulti', () => {
  // Breaks if getValueMulti stops honouring order — the first spelling listed is
  // the canonical ISO+ name and the rest are legacy variants of the same field.
  it('returns the first attribute name that is present, in order', () => {
    const mp = item({ 'Job status': 'Completed', 'Job Status': 'Cancelled' });
    expect(getValueMulti(mp, ['Job Status', 'Job status'])).toBe('Cancelled');
    expect(getValueMulti(mp, ['Job status', 'Job Status'])).toBe('Completed');
  });

  it('falls through null values and returns null when nothing matches', () => {
    const mp = item({ A: null, B: 'kept' });
    expect(getValueMulti(mp, ['A', 'B'])).toBe('kept');
    expect(getValueMulti(mp, ['Missing'])).toBeNull();
    expect(getValueMulti(mp, 'B')).toBe('kept');
    expect(getValue(null, 'B')).toBeNull();
    expect(getValue(item({}), 'B')).toBeNull();
  });
});

describe('parseNumberValue', () => {
  // Breaks on any change to the currency-string cleaning: ISO+ sends amounts as
  // formatted strings and a mis-parse becomes a wrong invoice total.
  it('parses formatted currency strings', () => {
    expect(parseNumberValue('1,234.50')).toBe(1234.5);
    expect(parseNumberValue('$67.89')).toBe(67.89);
    expect(parseNumberValue(' 12 ')).toBe(12);
  });

  // Breaks if either negative notation is dropped — a credit would be invoiced
  // as a positive charge.
  it('reads all three negative notations as negative', () => {
    expect(parseNumberValue('(50)')).toBe(-50);
    expect(parseNumberValue('50-')).toBe(-50);
    expect(parseNumberValue('−75.5')).toBe(-75.5);
    expect(parseNumberValue('-40.25')).toBe(-40.25);
  });

  it('returns 0 for anything unparseable', () => {
    expect(parseNumberValue(null)).toBe(0);
    expect(parseNumberValue(undefined)).toBe(0);
    expect(parseNumberValue('')).toBe(0);
    expect(parseNumberValue('   ')).toBe(0);
    expect(parseNumberValue('abc')).toBe(0);
    expect(parseNumberValue([])).toBe(0);
    expect(parseNumberValue({})).toBe(0);
    expect(parseNumberValue(true)).toBe(0);
    expect(parseNumberValue(Number.NaN)).toBe(0);
    expect(parseNumberValue(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('unwraps the first element of an array', () => {
    expect(parseNumberValue(['12.5', '99'])).toBe(12.5);
    expect(parseNumberValue([['3']])).toBe(3);
  });
});

describe('travel and transport amounts', () => {
  // Breaks on a wrong multiplier or a dropped "other costs" term: this is the
  // dollar amount claimed for provider travel.
  it('computes provider travel as price * mileage + other costs, to 2dp', () => {
    expect(computeProviderTravelNonLabourAmount(2.5, 10, 3)).toBe(28);
    expect(computeProviderTravelNonLabourAmount('1.11', '3', 0)).toBe(3.33);
  });

  // Breaks if the zero-price guard is removed: with no agreed rate only the
  // flat other-costs figure is claimable, and price*mileage would be 0 anyway
  // but the other costs would be lost.
  it('falls back to other costs alone when the unit price is zero or negative', () => {
    expect(computeProviderTravelNonLabourAmount(0, 10, 4.5)).toBe(4.5);
    expect(computeProviderTravelNonLabourAmount(-1, 10, 4.5)).toBe(4.5);
    expect(computeProviderTravelNonLabourAmount(0, 10, 0)).toBe(0);
    expect(computeActivityBaseTransportAmount(0, 10, 4.5)).toBe(4.5);
    expect(computeActivityBaseTransportAmount(3, 4, 0)).toBe(12);
  });

  // Breaks on an off-by-60 in the minutes→hours conversion, which would inflate
  // the labour travel claim sixtyfold.
  it('converts labour travel minutes to hours before pricing', () => {
    expect(computeLabourTravelTimeAmount(60, 30)).toBe(30);
    expect(computeLabourTravelTimeAmount(1.11, 50)).toBe(0.93);
    expect(computeLabourTravelTimeAmount(60, 0)).toBe(0);
    expect(computeLabourTravelTimeAmount(0, 30)).toBe(0);
    expect(computeLabourTravelTimeAmount(60, -30)).toBe(0);
  });
});

describe('round1 / isNonZero', () => {
  // Breaks if rounding changes: quantities on the claim are rounded to 0.1h,
  // and Math.round is half-up which is asymmetric for negatives.
  it('rounds to one decimal, half up towards +Infinity', () => {
    expect(round1(2.25)).toBe(2.3);
    expect(round1(2.24)).toBe(2.2);
    expect(round1(-2.25)).toBe(-2.2);
    expect(round1('3.06')).toBe(3.1);
    expect(round1('abc')).toBe(0);
    expect(round1(null)).toBe(0);
  });

  it('treats any non-zero magnitude as non-zero, including negatives', () => {
    expect(isNonZero('0.00')).toBe(false);
    expect(isNonZero(0)).toBe(false);
    expect(isNonZero(null)).toBe(false);
    expect(isNonZero('0.01')).toBe(true);
    expect(isNonZero('(5)')).toBe(true);
  });
});

describe('date helpers', () => {
  // Breaks on a wrong DST offset: Xero reads the offset literally, so a
  // January date stamped +10:00 lands on the previous day for the participant.
  it('stamps a date-only string with the Sydney offset for that date', () => {
    expect(dateOnlyToISOWithOffset('2026-01-15')).toBe('2026-01-15T00:00:00.000+11:00');
    expect(dateOnlyToISOWithOffset('2026-07-15')).toBe('2026-07-15T00:00:00.000+10:00');
    expect(dateOnlyToISOWithOffset('2026-01-15', 'UTC')).toBe('2026-01-15T00:00:00.000+00:00');
  });

  it('passes through anything that is not a bare yyyy-mm-dd', () => {
    expect(dateOnlyToISOWithOffset('2026-01-15T10:00:00Z')).toBe('2026-01-15T10:00:00Z');
    expect(dateOnlyToISOWithOffset('')).toBe('');
    expect(dateOnlyToISOWithOffset(null)).toBeNull();
  });

  // Breaks if the timezone is dropped: 14 Jan 14:30 UTC is 15 Jan in Sydney,
  // which is the service date printed on the invoice.
  it('converts an instant to the Sydney calendar date', () => {
    expect(getDateOnlyIso('2026-01-14T14:30:00.000Z')).toBe('2026-01-15');
    expect(formatDdMmYyyy('2026-01-14T14:30:00.000Z')).toBe('15/01/2026');
    expect(formatDateInValueZone('2026-01-14T14:30:00.000Z')).toBe('15/01/2026');
    expect(formatDateTimeInValueZone('2026-01-14T14:30:00.000Z')).toBe('15/01/2026, 01:30 am');
    expect(getDateOnlyIso('2026-01-14T14:30:00.000Z', 'UTC')).toBe('2026-01-14');
  });

  it('returns the documented empty value for missing and invalid dates', () => {
    expect(getDateOnlyIso(null)).toBeNull();
    expect(getDateOnlyIso('not a date')).toBeNull();
    expect(formatDdMmYyyy(null)).toBe('');
    expect(formatDdMmYyyy('not a date')).toBe('');
    expect(formatDateInValueZone('not a date')).toBe('');
    expect(formatDateTimeInValueZone('not a date')).toBe('');
  });
});

describe('duration formatting', () => {
  // Breaks on an off-by-one in the minute remainder, or on losing the zero pad,
  // which is what the NDIA claim CSV Hours column requires.
  it('formats hours and minutes as H:MM', () => {
    expect(hoursToHhhMm(1.5)).toBe('1:30');
    expect(hoursToHhhMm(10.05)).toBe('10:03');
    expect(minutesToHhhMm(90)).toBe('1:30');
    expect(minutesToHhhMm(59)).toBe('0:59');
  });

  it('returns an empty string for zero, negative and non-numeric durations', () => {
    expect(hoursToHhhMm(0)).toBe('');
    expect(hoursToHhhMm(-1)).toBe('');
    expect(hoursToHhhMm('abc')).toBe('');
    expect(minutesToHhhMm(0)).toBe('');
    expect(minutesToHhhMm(-5)).toBe('');
  });

  // Breaks if the H:MM passthrough is lost: ISO+ sometimes stores the duration
  // already formatted, and re-reading it as a number would give ''.
  it('passes an already-formatted H:MM string through, normalising the pad', () => {
    expect(formatDurationHhhMm('2:5')).toBe('2:05');
    expect(formatDurationHhhMm('2:05:30')).toBe('2:05');
    expect(formatDurationHhhMm('2:75')).toBe('');
  });

  it('honours the source unit for numeric input', () => {
    expect(formatDurationHhhMm(1.5)).toBe('1:30');
    expect(formatDurationHhhMm(90, 'minutes')).toBe('1:30');
    expect(formatDurationHhhMm('90', 'minutes')).toBe('1:30');
    expect(formatDurationHhhMm('1.5')).toBe('1:30');
    expect(formatDurationHhhMm(null)).toBe('');
    expect(formatDurationHhhMm('')).toBe('');
    expect(formatDurationHhhMm('   ')).toBe('');
  });
});

describe('sanitizeDigits', () => {
  // Breaks if the truncation or the non-digit strip is dropped: the NDIS number
  // goes onto the claim and must be digits only.
  it('keeps only digits and truncates to the max length', () => {
    expect(sanitizeDigits('430 123 456', 20)).toBe('430123456');
    expect(sanitizeDigits('43-01/23', 4)).toBe('4301');
    expect(sanitizeDigits('4301234567', 0)).toBe('4301234567');
    expect(sanitizeDigits(null)).toBe('');
    expect(sanitizeDigits(undefined)).toBe('');
    expect(sanitizeDigits('no digits', 5)).toBe('');
  });
});

describe('support catalogue accessors', () => {
  const support = item({
    'Support Item Number': '01_011_0107_1_1',
    'Support Item Name': 'Assistance With Self-Care Activities',
    'Short Notice Cancellations': 'Y',
  });

  // Breaks if the fallback order flips: the catalogue value is authoritative and
  // the service-plan text is only a fallback.
  it('prefers the catalogue value over the fallback', () => {
    expect(getSupportItemNumber(support, 'FALLBACK')).toBe('01_011_0107_1_1');
    expect(getSupportItemName(support, 'FALLBACK')).toBe('Assistance With Self-Care Activities');
    expect(getSupportItemNumber(null, ' FALLBACK ')).toBe('FALLBACK');
    expect(getSupportItemName(null, ' FALLBACK ')).toBe('FALLBACK');
    expect(getSupportItemNumber(null, '')).toBe('');
    expect(getSupportItemName(item({}))).toBe('');
  });

  it('accepts the alternate catalogue spellings', () => {
    expect(getSupportItemNumber(item({ 'Item Number': 'ALT-1' }))).toBe('ALT-1');
    expect(getSupportItemNumber(item({ 'Support Number': 'ALT-2' }))).toBe('ALT-2');
    expect(getSupportItemName(item({ 'Item Name': 'Alt Name' }))).toBe('Alt Name');
    expect(getSupportItemName(item({ Name: 'Alt Name 2' }))).toBe('Alt Name 2');
  });

  // Breaks if a truthy-but-not-yes value starts counting as yes: this flag is
  // the only thing that authorises a cancellation charge for a component.
  it('reads the short-notice cancellation flag as Y/YES/TRUE only', () => {
    expect(getShortNoticeCancellationsFlag(support)).toBe(true);
    expect(getShortNoticeCancellationsFlag(item({ 'Short Notice Cancellations': 'yes' }))).toBe(true);
    expect(getShortNoticeCancellationsFlag(item({ 'Short Notice Cancellation': 'true' }))).toBe(true);
    expect(getShortNoticeCancellationsFlag(item({ 'Short Notice Cancellations': 'N' }))).toBe(false);
    expect(getShortNoticeCancellationsFlag(item({ 'Short Notice Cancellations': '' }))).toBe(false);
    expect(getShortNoticeCancellationsFlag(null)).toBe(false);
  });
});

describe('participant accessors', () => {
  // Breaks if the preferred name stops winning — the participant sees the wrong
  // name on their invoice.
  it('prefers the preferred name over the full name', () => {
    expect(getParticipantDisplayName(item({
      'Preferred Name': 'Sam',
      'Full Name/Preferred Name': 'Samuel Rivers',
    }))).toBe('Sam');
    expect(getParticipantDisplayName(item({ 'Full Name/Preferred Name': 'Samuel Rivers' })))
      .toBe('Samuel Rivers');
    expect(getParticipantDisplayName(item({ Name: 'Samuel Rivers' }))).toBe('Samuel Rivers');
    expect(getParticipantDisplayName(item({}))).toBe('');
    expect(getParticipantDisplayName(null)).toBe('');
  });

  // Breaks if the "any key containing ndis" fallback is dropped: boards label
  // this column inconsistently and a missing NDIS number voids the claim.
  it('finds the NDIS number directly or by scanning ndis-ish keys', () => {
    expect(getParticipantNdisNumber(item({ 'NDIS Number': '430 123 456' }))).toBe('430123456');
    expect(getParticipantNdisNumber(item({ NDISNumber: '430123456' }))).toBe('430123456');
    expect(getParticipantNdisNumber(item({ 'Participant ndis no.': '43-01-23-456' }))).toBe('430123456');
    expect(getParticipantNdisNumber(item({ Name: 'Sam' }))).toBe('');
    expect(getParticipantNdisNumber(null)).toBe('');
  });
});

describe('mapCancellationReasonCode', () => {
  // Breaks if a code is swapped: these are the NDIA cancellation reason codes
  // submitted on the claim.
  it('maps the reason text to the NDIA code, defaulting to NSDO', () => {
    expect(mapCancellationReasonCode('Participant health')).toBe('NSDH');
    expect(mapCancellationReasonCode('Family matter')).toBe('NSDF');
    expect(mapCancellationReasonCode('No transport available')).toBe('NSDT');
    expect(mapCancellationReasonCode('Weather')).toBe('NSDO');
    expect(mapCancellationReasonCode('')).toBe('');
    expect(mapCancellationReasonCode(null)).toBe('');
  });

  // Breaks if the precedence order changes; health is checked before family.
  it('takes the first matching keyword when several appear', () => {
    expect(mapCancellationReasonCode('Family health issue')).toBe('NSDH');
  });
});

describe('claim CSV quantity/hours split', () => {
  // Breaks if a row code moves between the two columns: the NDIA rejects a
  // claim that fills Hours and Quantity at once, or fills the wrong one.
  it('classifies hour-based row codes', () => {
    expect(isHourBasedNdisClaimRow('direct_support_time', 'Each(E)')).toBe(true);
    expect(isHourBasedNdisClaimRow('support', '')).toBe(true);
    expect(isHourBasedNdisClaimRow('centre_capital_costs', '')).toBe(true);
    expect(isHourBasedNdisClaimRow('labour_travel_time', '')).toBe(true);
    expect(isHourBasedNdisClaimRow('non_face_to_face', '')).toBe(true);
    expect(isHourBasedNdisClaimRow('direct_support_non_time', 'Hour(H)')).toBe(false);
    expect(isHourBasedNdisClaimRow('allowances', 'Hour(H)')).toBe(false);
  });

  // Breaks if the cancellation rows stop depending on their unit: a cancelled
  // non-hour support is claimed as a quantity, an hourly one as hours.
  it('classifies canc_ rows by their unit', () => {
    expect(isHourBasedNdisClaimRow('canc_direct_support', 'Hour(H)')).toBe(true);
    expect(isHourBasedNdisClaimRow('canc_direct_support', 'Each(E)')).toBe(false);
    expect(isHourBasedNdisClaimRow('canc_support', null)).toBe(false);
  });

  it('fills exactly one of the two columns', () => {
    expect(mapNdisClaimCsvQuantityAndHours('support', 'Hour', 1.25)).toEqual({ quantity: '', hours: '1:18' });
    expect(mapNdisClaimCsvQuantityAndHours('allowances', 'Each(E)', 2)).toEqual({ quantity: '2.00', hours: '' });
    expect(mapNdisClaimCsvQuantityAndHours('allowances', 'Each(E)', '3.5')).toEqual({ quantity: '3.50', hours: '' });
    expect(mapNdisClaimCsvQuantityAndHours('allowances', 'Each(E)', 'abc')).toEqual({ quantity: '', hours: '' });
    expect(mapNdisClaimCsvQuantityAndHours('support', 'Hour', 0)).toEqual({ quantity: '', hours: '' });
  });

  // Breaks if the round1 step before the H:MM conversion is dropped: 1.25h
  // rounds to 1.3h = 1:18, not the un-rounded 1:15.
  it('applies the 0.1h invoice rounding before converting to H:MM', () => {
    expect(formatHoursHhhMmForCsv(1.25)).toBe('1:18');
    expect(formatHoursHhhMmForCsv('2')).toBe('2:00');
    expect(formatHoursHhhMmForCsv(0)).toBe('');
    expect(formatHoursHhhMmForCsv(-2)).toBe('');
    expect(formatHoursHhhMmForCsv('abc')).toBe('');
  });
});

describe('reference display-name resolution', () => {
  // Breaks if the uuid guard is dropped: the invoice would print a raw uuid as
  // the cancellation reason.
  it('takes the first priority key that is a real label, never a uuid', () => {
    expect(resolveRefItemDisplayName(item({ 'Cancellation Reason': 'Participant unwell', Name: 'X' })))
      .toBe('Participant unwell');
    expect(resolveRefItemDisplayName(item({ Name: 'Sleepover' }))).toBe('Sleepover');
    expect(resolveRefItemDisplayName(item({ Definition: 'Overnight support' }))).toBe('Overnight support');
    expect(resolveRefItemDisplayName(item({ 'Cancellation Reason': UUID_A, Name: 'Real' }))).toBe('Real');
    expect(resolveRefItemDisplayName(null)).toBe('');
    expect(resolveRefItemDisplayName(item({}))).toBe('');
  });

  // Breaks if the >1 character rule is removed: single-character codes would be
  // shown instead of the descriptive value further down the object.
  it('scans remaining values, skipping uuids and single characters', () => {
    expect(resolveRefItemDisplayName(item({ Code: 'A', Description: 'Participant illness' })))
      .toBe('Participant illness');
    expect(resolveRefItemDisplayName(item({ RefId: UUID_A }))).toBe('');
  });

  it('resolves a cancellation reason through the ref lookup', () => {
    const resolve = vi.fn((id) => (id === UUID_A ? 'Participant health' : ''));
    expect(resolveCancellationReasonLabel([{ id: UUID_A }], resolve)).toBe('Participant health');
    expect(resolve).toHaveBeenCalledWith(UUID_A);
  });

  // Breaks if the "unresolved uuid" case leaks: an unfound reference must show
  // nothing rather than a uuid.
  it('returns an empty label when the reference cannot be resolved', () => {
    expect(resolveCancellationReasonLabel([{ id: UUID_A }], () => '')).toBe('');
    expect(resolveCancellationReasonLabel(UUID_A, () => '')).toBe('');
  });

  it('falls back to plain label text when there is no reference id', () => {
    expect(resolveCancellationReasonLabel(['Participant health', 'Weather'], () => ''))
      .toBe('Participant health, Weather');
    expect(resolveCancellationReasonLabel('Participant health', () => '')).toBe('Participant health');
    expect(resolveCancellationReasonLabel(null, () => '')).toBe('');
  });
});

describe('shift status helpers', () => {
  it('matches the status words case- and whitespace-insensitively', () => {
    expect(isCompletedShiftStatus(' Completed ')).toBe(true);
    expect(isCompletedShiftStatus('COMPLETED')).toBe(true);
    expect(isCompletedShiftStatus('Complete')).toBe(false);
    expect(isCancelledShiftStatus(' cancelled')).toBe(true);
    expect(isCancelledShiftStatus('Canceled')).toBe(false);
    expect(isCancelledShiftStatus(null)).toBe(false);
    expect(isHourUnitLabel('Hour(H)')).toBe(true);
    expect(isHourUnitLabel(' hour ')).toBe(true);
    expect(isHourUnitLabel('Each(E)')).toBe(false);
    expect(isHourUnitLabel(null)).toBe(false);
  });

  // Breaks on swapping the cancelled/delivered date sources: a cancelled shift
  // has no actual times, so it must be claimed against the scheduled window.
  it('picks scheduled dates for a cancelled shift and actual dates otherwise', () => {
    const args = {
      scheduledStart: '2026-01-14T22:00:00.000Z',
      scheduledEnd: '2026-01-15T01:00:00.000Z',
      actualStart: '2026-01-15T22:00:00.000Z',
      actualEnd: '2026-01-16T01:00:00.000Z',
    };
    expect(resolveNdisSupportDeliveredDates({ jobStatus: 'Cancelled', ...args })).toEqual({
      supportDeliveredFrom: '15/01/2026',
      supportDeliveredTo: '15/01/2026',
    });
    expect(resolveNdisSupportDeliveredDates({ jobStatus: 'Completed', ...args })).toEqual({
      supportDeliveredFrom: '16/01/2026',
      supportDeliveredTo: '16/01/2026',
    });
  });

  it('falls back to the other date pair when the preferred one is missing', () => {
    expect(resolveNdisSupportDeliveredDates({
      jobStatus: 'Cancelled',
      actualStart: '2026-01-15T22:00:00.000Z',
      actualEnd: '2026-01-16T01:00:00.000Z',
    })).toEqual({ supportDeliveredFrom: '16/01/2026', supportDeliveredTo: '16/01/2026' });

    expect(resolveNdisSupportDeliveredDates({
      jobStatus: 'Completed',
      scheduledStart: '2026-01-14T22:00:00.000Z',
      scheduledEnd: '2026-01-15T01:00:00.000Z',
    })).toEqual({ supportDeliveredFrom: '15/01/2026', supportDeliveredTo: '15/01/2026' });
  });

  it('accepts an injected date formatter', () => {
    const formatDate = vi.fn(() => 'X');
    expect(resolveNdisSupportDeliveredDates({ jobStatus: 'Completed', actualStart: 'a', actualEnd: 'b', formatDate }))
      .toEqual({ supportDeliveredFrom: 'X', supportDeliveredTo: 'X' });
    expect(formatDate).toHaveBeenNthCalledWith(1, 'a');
    expect(formatDate).toHaveBeenNthCalledWith(2, 'b');
  });
});

describe('claim type resolution', () => {
  it('recognises a cancellation row by claim type or code prefix', () => {
    expect(isCancellationClaimRow('canc', '')).toBe(true);
    expect(isCancellationClaimRow('', 'canc_direct_support')).toBe(true);
    expect(isCancellationClaimRow('CANC', 'support')).toBe(true);
    expect(isCancellationClaimRow('', 'support')).toBe(false);
    expect(isCancellationClaimRow(null)).toBe(false);
  });

  // Breaks if the word boundary is dropped: "Telehealthcare Centre" would then
  // wrongly become a telehealth claim.
  it('detects telehealth delivery only on a whole word', () => {
    expect(isTelehealthServiceMode([{ name: 'Telehealth' }])).toBe(true);
    expect(isTelehealthServiceMode('THLT')).toBe(true);
    expect(isTelehealthServiceMode('Face to Face')).toBe(false);
    expect(isTelehealthServiceMode('Telehealthcare')).toBe(false);
    expect(isTelehealthServiceMode(null)).toBe(false);
  });

  // Breaks if the precedence changes: an explicit claim type must win over the
  // item-number suffix, and the suffix over the delivery mode.
  it('prefers an explicit claim type, then the item-number suffix', () => {
    expect(resolveNdisClaimType('canc', 'Telehealth', 'support', '01_011_0107_1_1_TH')).toBe('CANC');
    expect(resolveNdisClaimType('', 'Face to Face', 'support', '01_011_0107_1_1_TH')).toBe('THLT');
    expect(resolveNdisClaimType('', '', 'support', '01_011_0107_1_1_NF')).toBe('NF2F');
    expect(resolveNdisClaimType('', '', 'support', '01_011_0107_1_1_RR')).toBe('RR');
    expect(resolveNdisClaimType('', '', 'support', '01_011_0107_1_1_PT')).toBe('PT');
  });

  // Breaks if the eligible-code set widens: allowances and travel rows must not
  // be claimed as telehealth even on a telehealth shift.
  it('applies the telehealth mode only to the eligible support codes', () => {
    expect(resolveNdisClaimType('', 'Telehealth', 'support', '')).toBe('THLT');
    expect(resolveNdisClaimType('', 'Telehealth', 'direct_support_time', '')).toBe('THLT');
    expect(resolveNdisClaimType('', 'Telehealth', 'centre_capital_costs', '')).toBe('THLT');
    expect(resolveNdisClaimType('', 'Telehealth', 'allowances', '')).toBe('');
    expect(resolveNdisClaimType('', 'Telehealth', 'provider_travel_non_labour', '')).toBe('');
    expect(resolveNdisClaimType('', 'Face to Face', 'support', '')).toBe('');
    expect(resolveNdisClaimType()).toBe('');
  });
});

describe('buildServiceItemDescription', () => {
  const times = {
    actualStart: '2026-01-14T22:00:00.000Z',
    actualEnd: '2026-01-15T01:00:00.000Z',
    scheduledStart: '2026-01-13T22:00:00.000Z',
    scheduledEnd: '2026-01-14T01:00:00.000Z',
  };

  // Breaks on a changed separator or a lost time range — this string is the
  // service description printed on the invoice line.
  it('joins name, number, the shift window and the group size', () => {
    expect(buildServiceItemDescription({
      itemNumber: '01_011_0107_1_1',
      itemName: 'Assistance With Self-Care',
      unit: 'Hour(H)',
      jobStatus: 'Completed',
      ...times,
      fallback: 'Direct Support',
      groupSize: 2,
      timeZone: TZ,
    })).toBe('Assistance With Self-Care - 01_011_0107_1_1 - from 15/01/2026, 09:00 am to 15/01/2026, 12:00 pm - Group Size: 2');
  });

  // Breaks if the cancelled branch stops using scheduled times: a cancelled
  // shift has no actual window.
  it('uses the scheduled window for a cancelled shift', () => {
    expect(buildServiceItemDescription({
      itemNumber: 'X1',
      itemName: '',
      unit: 'Hour(H)',
      jobStatus: 'Cancelled',
      ...times,
      fallback: 'Cancellation Fee',
      timeZone: TZ,
    })).toBe('X1 - from 14/01/2026, 09:00 am to 14/01/2026, 12:00 pm');
  });

  it('omits the time range for a non-hour unit or an in-progress status', () => {
    expect(buildServiceItemDescription({
      itemNumber: 'X1', itemName: 'Report', unit: 'Each(E)', jobStatus: 'Completed', ...times, timeZone: TZ,
    })).toBe('Report - X1');
    expect(buildServiceItemDescription({
      itemNumber: 'X1', itemName: 'Report', unit: 'Hour(H)', jobStatus: 'Scheduled', ...times, timeZone: TZ,
    })).toBe('Report - X1');
  });

  it('falls back when there is neither name nor number, and omits group size 1', () => {
    expect(buildServiceItemDescription({ fallback: 'Direct Support', groupSize: 1 })).toBe('Direct Support');
    expect(buildServiceItemDescription({})).toBe('Service');
    expect(buildServiceItemDescription({ itemName: 'Solo', groupSize: '1' })).toBe('Solo');
    expect(buildServiceItemDescription({ itemName: 'Group', groupSize: 3 })).toBe('Group - Group Size: 3');
  });
});

describe('collectNdisSupportCatalogueRefIds', () => {
  const legacyPlan = {
    'Direct Support Item Number': [{ id: UUID_A }],
    'Provider Travel - Non-Labour Cost Item Number': [{ id: UUID_B }],
    'Activity Based Transport Item Number': [{ id: 'not-a-uuid' }],
    'Centre Capital Costs Item': [{ id: 'cccccccc-3333-4111-8111-cccccccccccc' }],
    'Support Item Number': [{ id: 'dddddddd-4444-4111-8111-dddddddddddd' }],
  };

  // Breaks if the legacy/new split leaks: fetching the wrong catalogue columns
  // leaves the invoice line without an item number.
  it('collects only the legacy columns under the legacy rule', () => {
    expect(collectNdisSupportCatalogueRefIds(legacyPlan)).toEqual([
      UUID_A,
      UUID_B,
      'cccccccc-3333-4111-8111-cccccccccccc',
    ]);
    expect(collectNdisSupportCatalogueRefIds(legacyPlan, 'legacy')).toEqual([
      UUID_A,
      UUID_B,
      'cccccccc-3333-4111-8111-cccccccccccc',
    ]);
  });

  it('collects the 2026-27 columns under the new rule', () => {
    expect(collectNdisSupportCatalogueRefIds({
      'Support Item Number': [{ id: UUID_A }],
      'Provider Travel - Non-Labour Cost Item Number': [{ id: UUID_B }],
      'Provider Travel - Labour Travel Time Costs Item Number': [{ id: 'cccccccc-3333-4111-8111-cccccccccccc' }],
      'Cancellation Item Number': [{ id: 'dddddddd-4444-4111-8111-dddddddddddd' }],
      'Activity Based Transport Item Number': [{ id: 'eeeeeeee-5555-4111-8111-eeeeeeeeeeee' }],
      'Direct Support Item Number': [{ id: 'ffffffff-6666-4111-8111-ffffffffffff' }],
    }, 'new')).toEqual([
      UUID_A,
      UUID_B,
      'cccccccc-3333-4111-8111-cccccccccccc',
      'dddddddd-4444-4111-8111-dddddddddddd',
      'eeeeeeee-5555-4111-8111-eeeeeeeeeeee',
    ]);
  });

  it('returns an empty array for missing or non-object service plan data', () => {
    expect(collectNdisSupportCatalogueRefIds(null)).toEqual([]);
    expect(collectNdisSupportCatalogueRefIds('nope')).toEqual([]);
    expect(collectNdisSupportCatalogueRefIds({})).toEqual([]);
  });
});

describe('buildNdisSupportCatalogueForServicePlan', () => {
  const supportItem = item({ 'Support Item Name': 'Support' });
  const travelItem = item({ 'Support Item Name': 'Travel' });
  const refItemsMap = new Map([[UUID_A, supportItem], [UUID_B, travelItem]]);

  // Breaks if a catalogue slot is renamed or wired to the wrong column — the
  // row builders read these slot names directly.
  it('resolves the legacy slots', () => {
    const catalogue = buildNdisSupportCatalogueForServicePlan(
      item({
        'Direct Support Item Number': [{ id: UUID_A }],
        'Provider Travel - Non-Labour Cost Item Number': [{ id: UUID_B }],
      }),
      refItemsMap,
    );
    expect(Object.keys(catalogue).sort())
      .toEqual(['activityTransport', 'centreCapital', 'directSupport', 'providerTravelNonLabour']);
    expect(catalogue.directSupport).toBe(supportItem);
    expect(catalogue.providerTravelNonLabour).toBe(travelItem);
    expect(catalogue.activityTransport).toBeNull();
  });

  it('resolves the new slots', () => {
    const catalogue = buildNdisSupportCatalogueForServicePlan(
      item({ 'Support Item Number': [{ id: UUID_A }] }),
      refItemsMap,
      'new',
    );
    expect(Object.keys(catalogue).sort())
      .toEqual(['activityTransport', 'cancellation', 'labourTravelTime', 'providerTravelNonLabour', 'support']);
    expect(catalogue.support).toBe(supportItem);
    expect(catalogue.cancellation).toBeNull();
  });

  it('returns an empty object without a service plan or a ref map', () => {
    expect(buildNdisSupportCatalogueForServicePlan(null, refItemsMap)).toEqual({});
    expect(buildNdisSupportCatalogueForServicePlan(item({}), null)).toEqual({});
  });

  // Breaks if a missing reference throws instead of resolving to undefined.
  it('yields undefined for an id the map does not hold', () => {
    const catalogue = buildNdisSupportCatalogueForServicePlan(
      item({ 'Direct Support Item Number': [{ id: 'zzzzzzzz-9999-4111-8111-zzzzzzzzzzzz' }] }),
      refItemsMap,
    );
    expect(catalogue.directSupport).toBeUndefined();
  });
});

describe('buildNdisMasterPlanServiceRows dispatch', () => {
  const servicePlan = item({
    'Unit (Direct Support)': 'Hour(H)',
    'Agreed Unit Price for Direct Support ($)': '70.00',
    'Unit (Support)': 'Hour',
    'Agreed Unit Price for Support ($)': '80.00',
  });
  const masterPlanItem = item({
    'Job Status': 'Completed',
    'Actual Shift Duration(Hr.)': '2',
    'Direct Support Value($) - Time Based Support': '140.00',
    'Support Value($)': '160.00',
  });

  // Breaks if the dispatch inverts: the legacy builder emits `direct_support_time`
  // priced off the legacy columns, the new one emits `support`.
  it('routes to the new builder only for pricingRule "new"', () => {
    const newRows = buildNdisMasterPlanServiceRows({ masterPlanItem, servicePlanItem: servicePlan, pricingRule: 'new' });
    expect(newRows.map((r) => r.code)).toEqual(['support']);
    expect(newRows[0].unitPrice).toBe(80);

    const legacyRows = buildNdisMasterPlanServiceRows({ masterPlanItem, servicePlanItem: servicePlan, pricingRule: 'legacy' });
    expect(legacyRows.map((r) => r.code)).toEqual(['direct_support_time']);
    expect(legacyRows[0].unitPrice).toBe(70);
  });

  it('defaults to the legacy builder when no rule is given', () => {
    const rows = buildNdisMasterPlanServiceRows({ masterPlanItem, servicePlanItem: servicePlan });
    expect(rows.map((r) => r.code)).toEqual(['direct_support_time']);
    expect(rows).toEqual(buildLegacyNdisMasterPlanServiceRows({ masterPlanItem, servicePlanItem: servicePlan }));
  });
});
