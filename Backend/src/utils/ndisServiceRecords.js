const SYDNEY_TIME_ZONE = 'Australia/Sydney';

import { buildNewNdisMasterPlanServiceRows } from './ndisServiceRecordsNew.js';
import { buildLegacyNdisMasterPlanServiceRows as buildLegacyNdisMasterPlanServiceRowsImpl } from './ndisLegacyMasterPlanServiceHelpers.js';

export const NDIS_MASTERPLAN_ATTR = {
  PARTICIPANT_PROFILE: 'Participant Profile',
  PARTICIPANT_FULL_NAME: 'Participant Full Name',
  SERVICE_PLAN: 'Service Plan',
  TIMESHEET_APPROVAL: 'Timesheet Approval',

  JOB_STATUS: 'Job Status',
  PAYMENT_STATUS: 'Payment Status',

  GROUP_SIZE: 'Group Size',

  SCHEDULED_START: 'Scheduled Shift Start Date & Time',
  SCHEDULED_END: 'Scheduled Shift End Date & Time',
  SCHEDULED_DURATION_HR: 'Scheduled Shift Duration(Hr.)',

  ACTUAL_START: 'Actual Shift Start Date and Time',
  ACTUAL_END: 'Actual Shift End Date and Time',
  ACTUAL_DURATION_HR: 'Actual Shift Duration(Hr.)',

  QUANTITY_DIRECT_SUPPORT_NON_TIME: 'Quantity (Direct Support - Non Time Based Support)',

  DIRECT_SUPPORT_VALUE_TIME: 'Direct Support Value($) - Time Based Support',
  DIRECT_SUPPORT_VALUE_NON_TIME: 'Direct Support Value($) - Non Time Based Support',

  PROVIDER_TRAVEL_NON_LABOUR_AMOUNT: 'Provider Travel - Non-Labour Cost Amount($)',
  ACTIVITY_BASE_TRANSPORT_AMOUNT: 'Activity Base Transport Amount($)',
  CENTRE_CAPITAL_COSTS_AMOUNT: 'Centre Capital Costs Amount($)',
  LABOUR_TRAVEL_TIME_AMOUNT: 'Labour Travel Time Amount($)',
  ALLOWANCES_AMOUNT: 'Allowances Amount($)',
  NON_FACE_TO_FACE_AMOUNT: 'Non-Face-to-Face Amount($)',
  CANCELLATION_FEE: 'Cancellation Fee($)',

  PROVIDER_TRAVEL_MILEAGE: 'Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a vehicle is used.',
  PROVIDER_TRAVEL_OTHER_COSTS: 'Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied.',
  ACTIVITY_TRANSPORT_MILEAGE: 'Activity Base Transport Mileage(Kms) as per the Service Plan, if a vehicle is used.',
  ACTIVITY_TRANSPORT_OTHER_COSTS: 'Activity Base Transport Costs as per the Service Plan, if other costs are applied.',

  LABOUR_TRAVEL_TIME_MIN:
    'Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable.',

  USED_ALLOWANCE_AMOUNT: 'Used Allowance Amount($) as per the Service Plan',
  ALLOWANCES_TYPE: 'Allowances',

  NON_FACE_TO_FACE_SUPPORTS: 'Non-Face-to-Face Supports',
  NON_FACE_TO_FACE_TIME_HR:
    'Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)',

  CANCELLATION_REASON: 'Cancellation Reason',
  SERVICE_DELIVERY_MODE: 'Service Delivery Mode',

  // 2026-27 NDIS Pricing Schedule (master plan amount fields)
  SUPPORT_VALUE: 'Support Value($)',
  QUANTITY_NON_TIME_BASED: 'Quantity (Non-Time-Based Support)',
};

export const NDIS_SERVICEPLAN_ATTR = {
  UNIT_DIRECT_SUPPORT: 'Unit (Direct Support)',
  PRICE_DIRECT_SUPPORT: 'Agreed Unit Price for Direct Support ($)',
  ITEM_DIRECT_SUPPORT: 'Direct Support Item Number',

  UNIT_PROVIDER_TRAVEL_NON_LABOUR: 'Unit (Provider Travel - Non-Labour Cost)',
  PRICE_PROVIDER_TRAVEL_NON_LABOUR: 'Agreed Unit Price for Non-Labour Travel ($)',
  ITEM_PROVIDER_TRAVEL_NON_LABOUR: 'Provider Travel - Non-Labour Cost Item Number',

  UNIT_ACTIVITY_TRANSPORT: 'Unit (Activity Based Transport)',
  PRICE_ACTIVITY_TRANSPORT: 'Agreed Price for Activity Based Transport ($)',
  ITEM_ACTIVITY_TRANSPORT: 'Activity Based Transport Item Number',

  UNIT_CENTRE_CAPITAL: 'Unit (Centre Capital Costs)',
  PRICE_CENTRE_CAPITAL: 'Agreed Unit Price for Centre Capital Costs($)',
  ITEM_CENTRE_CAPITAL: 'Centre Capital Costs Item',

  UNIT_LABOUR_TRAVEL_TIME: 'Unit (Labour Travel Time)',
  PRICE_LABOUR_TRAVEL_TIME: 'Agreed Unit Price for Labour Travel Time ($)',

  UNIT_ALLOWANCES: 'Unit (Allowances)',
  PRICE_ALLOWANCES: 'Agreed Price for Allowances($)',

  UNIT_NON_FACE_TO_FACE: 'Unit (Non-Face-to-Face Support)',
  PRICE_NON_FACE_TO_FACE: 'Agreed Unit Price for Non-Face-to-Face Support($)',

  ALLOWANCES_TYPE: 'Allowances',

  // 2026-27 NDIS Pricing Schedule (service plan fields)
  ITEM_SUPPORT: 'Support Item Number',
  UNIT_SUPPORT: 'Unit (Support)',
  PRICE_SUPPORT: 'Agreed Unit Price for Support ($)',
  ITEM_LABOUR_TRAVEL_TIME: 'Provider Travel - Labour Travel Time Costs Item Number',
  ITEM_CANCELLATION: 'Cancellation Item Number',
  UNIT_CANCELLATION: 'Unit (Cancellation)',
  PRICE_CANCELLATION: 'Agreed Unit Price for Cancellation ($)',
};

export const NDIS_SUPPORT_CATALOGUE_ATTR = {
  SUPPORT_ITEM_NUMBER: 'Support Item Number',
  SUPPORT_ITEM_NAME: 'Support Item Name',
  SHORT_NOTICE_CANCELLATIONS: 'Short Notice Cancellations',
};

export const NDIS_CANCELLATION_TYPE_ATTR = {
  BILLABLE_TO_CLIENT_PCT: 'Billable to Client %',
};

export function isUuidLike(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function extractRefId(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === 'object' && first?.id) return String(first.id);
    if (typeof first === 'string') return first;
    return first?.toString ? String(first.toString()) : null;
  }
  if (typeof value === 'object' && value?.id) return String(value.id);
  if (typeof value === 'string') return value;
  return value?.toString ? String(value.toString()) : null;
}

export function extractAllRefIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === 'object' && v?.id) return String(v.id);
        if (typeof v === 'string') return v;
        return v?.toString ? String(v.toString()) : null;
      })
      .filter(Boolean);
  }
  if (typeof value === 'object' && value?.id) return [String(value.id)];
  if (typeof value === 'string') return [value];
  return value?.toString ? [String(value.toString())] : [];
}

export function formatLabelValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .map((v) => formatLabelValue(v))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') {
    if (value.name) return String(value.name);
    if (value.label) return String(value.label);
    if (value.value) return String(value.value);
    if (value.id) return String(value.id);
    return value.toString ? String(value.toString()) : '';
  }
  return String(value);
}

export function getValue(item, attributeName) {
  return item?.data?.[attributeName] ?? null;
}

export function getValueMulti(item, attributeNames) {
  const names = Array.isArray(attributeNames) ? attributeNames : [attributeNames];
  for (const name of names) {
    const v = getValue(item, name);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function getMasterPlanLabel(masterPlanItem, attributeNames) {
  const raw = getValueMulti(masterPlanItem, attributeNames);
  return formatLabelValue(raw).trim();
}

function getMasterPlanNumber(masterPlanItem, attributeNames) {
  const raw = getValueMulti(masterPlanItem, attributeNames);
  return parseNumberValue(raw);
}

function getServicePlanLabel(servicePlanItem, attributeNames) {
  const raw = getValueMulti(servicePlanItem, attributeNames);
  return formatLabelValue(raw).trim();
}

function getServicePlanNumber(servicePlanItem, attributeNames) {
  const raw = getValueMulti(servicePlanItem, attributeNames);
  return parseNumberValue(raw);
}

export function parseNumberValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return 0;
  if (Array.isArray(rawValue) && rawValue.length > 0) return parseNumberValue(rawValue[0]);
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : 0;
  if (typeof rawValue !== 'string') return 0;

  let s = rawValue.trim();
  if (!s) return 0;

  // Normalize unicode minus to ASCII hyphen-minus.
  s = s.replace(/[\u2212\u2012\u2013\u2014]/g, '-');

  let negative = false;
  if (/\(.*\)/.test(s)) {
    negative = true;
    s = s.replace(/[()]/g, '');
  }
  if (/-\s*$/.test(s)) {
    negative = true;
    s = s.replace(/-\s*$/, '');
  }

  const cleaned = s.replace(/[^0-9.+-]/g, '');
  const parsed = parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -Math.abs(parsed) : parsed;
}

export function computeProviderTravelNonLabourAmount(unitPrice, mileage, otherCosts) {
  const price = parseNumberValue(unitPrice);
  const mileageNum = parseNumberValue(mileage);
  const othersNum = parseNumberValue(otherCosts);
  if (price <= 0) return othersNum > 0 ? parseFloat(othersNum.toFixed(2)) : 0;
  return parseFloat((price * mileageNum + othersNum).toFixed(2));
}

export function computeActivityBaseTransportAmount(unitPrice, mileage, otherCosts) {
  const price = parseNumberValue(unitPrice);
  const mileageNum = parseNumberValue(mileage);
  const othersNum = parseNumberValue(otherCosts);
  if (price <= 0) return othersNum > 0 ? parseFloat(othersNum.toFixed(2)) : 0;
  return parseFloat((price * mileageNum + othersNum).toFixed(2));
}

export function computeLabourTravelTimeAmount(unitPrice, minutes) {
  const price = parseNumberValue(unitPrice);
  const minutesNum = parseNumberValue(minutes);
  if (price <= 0 || minutesNum <= 0) return 0;
  return parseFloat((price * (minutesNum / 60)).toFixed(2));
}

export function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

export function isNonZero(value) {
  return Math.abs(parseNumberValue(value)) > 0;
}

export function dateOnlyToISOWithOffset(dateStr, timeZone = SYDNEY_TIME_ZONE) {
  if (!dateStr) return dateStr;
  const str = String(dateStr).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return dateStr;
  const [y, m, d] = str.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(noonUtc);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const localMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = localMs - noonUtc.getTime();
  const offsetMin = Math.round(offsetMs / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  return `${str}T00:00:00.000${sign}${hh}:${mm}`;
}

export function getDateOnlyIso(value, timeZone = SYDNEY_TIME_ZONE) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

export function formatDdMmYyyy(value, timeZone = SYDNEY_TIME_ZONE) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const day = parts.find((p) => p.type === 'day')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const year = parts.find((p) => p.type === 'year')?.value;
  if (!day || !month || !year) return '';
  return `${day}/${month}/${year}`;
}

export function formatDateInValueZone(value, timeZone = SYDNEY_TIME_ZONE) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return formatDdMmYyyy(value, timeZone);
}

export function formatDateTimeInValueZone(value, timeZone = SYDNEY_TIME_ZONE) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-AU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function hoursToHhhMm(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return '';
  const totalMinutes = Math.round(h * 60);
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${wholeHours}:${String(minutes).padStart(2, '0')}`;
}

export function minutesToHhhMm(minutesValue) {
  const m = Number(minutesValue);
  if (!Number.isFinite(m) || m <= 0) return '';
  const totalMinutes = Math.round(m);
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${wholeHours}:${String(minutes).padStart(2, '0')}`;
}

function formatDurationFromTimeString(s) {
  const timeMatch = s.match(/^(\d+):(\d{1,2})(?::\d{1,2})?$/);
  if (!timeMatch) return null;
  const h = Number(timeMatch[1]);
  const m = Number(timeMatch[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || m < 0 || m >= 60) return null;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function formatDurationFromString(s, source) {
  const formatted = formatDurationFromTimeString(s);
  if (formatted) return formatted;
  const n = Number(s);
  if (!Number.isFinite(n)) return '';
  return source === 'minutes' ? minutesToHhhMm(n) : hoursToHhhMm(n);
}

export function formatDurationHhhMm(value, source = 'hours') {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return '';
    return formatDurationFromString(s, source);
  }

  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return source === 'minutes' ? minutesToHhhMm(n) : hoursToHhhMm(n);
}

export function sanitizeDigits(value, maxLen) {
  if (value === null || value === undefined) return '';
  const digits = String(value).replace(/\D/g, '');
  if (!maxLen) return digits;
  return digits.slice(0, maxLen);
}

export function getSupportItemNumber(supportItem, fallbackValue = '') {
  const n = getValueMulti(supportItem, [
    NDIS_SUPPORT_CATALOGUE_ATTR.SUPPORT_ITEM_NUMBER,
    'Item Number',
    'Support Number',
  ]);
  const nStr = n ? String(n).trim() : '';
  if (nStr) return nStr;
  if (fallbackValue) return String(fallbackValue).trim();
  return '';
}

export function getSupportItemName(supportItem, fallbackValue = '') {
  const n = getValueMulti(supportItem, [
    NDIS_SUPPORT_CATALOGUE_ATTR.SUPPORT_ITEM_NAME,
    'Item Name',
    'Name',
  ]);
  const nStr = n ? String(n).trim() : '';
  if (nStr) return nStr;
  if (fallbackValue) return String(fallbackValue).trim();
  return '';
}

export function getShortNoticeCancellationsFlag(supportItem) {
  const raw = getValueMulti(supportItem, [
    NDIS_SUPPORT_CATALOGUE_ATTR.SHORT_NOTICE_CANCELLATIONS,
    'Short Notice Cancellation',
  ]);
  const s = formatLabelValue(raw).trim().toUpperCase();
  return s === 'Y' || s === 'YES' || s === 'TRUE';
}

export function getParticipantDisplayName(participantProfileItem) {
  const preferred = getValueMulti(participantProfileItem, ['Preferred Name', 'Preferred name']);
  const full = getValueMulti(participantProfileItem, ['Full Name/Preferred Name', 'Full Name', 'Name']);
  const preferredStr = preferred ? String(preferred).trim() : '';
  const fullStr = full ? String(full).trim() : '';
  return preferredStr || fullStr || '';
}

export function getParticipantNdisNumber(participantProfileItem) {
  const direct = getValueMulti(participantProfileItem, ['NDIS Number', 'NDISNumber']);
  const directStr = direct ? String(direct).trim() : '';
  if (directStr) return sanitizeDigits(directStr, 20);

  // Fallback: scan keys that include "ndis"
  const data = participantProfileItem?.data;
  if (!data || typeof data !== 'object') return '';
  const key = Object.keys(data).find((k) => k && k.toLowerCase().includes('ndis'));
  if (!key) return '';
  return sanitizeDigits(data[key], 20);
}

export function mapCancellationReasonCode(cancellationReasonLabel) {
  const s = String(cancellationReasonLabel || '').toLowerCase();
  if (!s) return '';
  if (s.includes('health')) return 'NSDH';
  if (s.includes('family')) return 'NSDF';
  if (s.includes('transport')) return 'NSDT';
  return 'NSDO';
}

/** Hours column in HHH:MM (applies invoice round1 before conversion). */
export function formatHoursHhhMmForCsv(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return hoursToHhhMm(round1(n));
}

export function isHourBasedNdisClaimRow(rowCode, unit) {
  const unitStr = (unit || '').toString();
  const isHourUnit = unitStr.toLowerCase().includes('hour');
  const code = String(rowCode || '');
  if (code === 'direct_support_time' || code === 'support') return true;
  if (code === 'centre_capital_costs') return true;
  if (code === 'labour_travel_time') return true;
  if (code === 'non_face_to_face') return true;
  if (code.startsWith('canc_') && isHourUnit) return true;
  return false;
}

/** Hour-based rows → Hours column; other rows → Quantity column (NDIS: mutually exclusive). */
export function mapNdisClaimCsvQuantityAndHours(rowCode, unit, quantity) {
  if (isHourBasedNdisClaimRow(rowCode, unit)) {
    return { quantity: '', hours: formatHoursHhhMmForCsv(quantity) };
  }
  const n = typeof quantity === 'number' ? quantity : Number(quantity);
  if (!Number.isFinite(n)) return { quantity: '', hours: '' };
  return { quantity: n.toFixed(2), hours: '' };
}

export function resolveRefItemDisplayName(refItem) {
  if (!refItem?.data) return '';
  const priorityKeys = ['Cancellation Reason', 'Name', 'Definition'];
  for (const key of priorityKeys) {
    const label = formatLabelValue(refItem.data[key]).trim();
    if (label && !isUuidLike(label)) return label;
  }
  for (const v of Object.values(refItem.data)) {
    const label = formatLabelValue(v).trim();
    if (label && !isUuidLike(label) && label.length > 1) return label;
  }
  return '';
}

export function resolveCancellationReasonLabel(cancellationReasonValue, resolveRefById) {
  const crIds = extractAllRefIds(cancellationReasonValue).filter(isUuidLike);
  let label = '';
  if (crIds.length > 0) {
    label = crIds.map((id) => resolveRefById(id)).filter(Boolean).join(', ');
  }
  if (!label && Array.isArray(cancellationReasonValue)) {
    label = cancellationReasonValue
      .map((v) => formatLabelValue(v).trim())
      .filter((part) => part && !isUuidLike(part))
      .join(', ');
  }
  if (!label) {
    label = formatLabelValue(cancellationReasonValue).trim();
  }
  if (isUuidLike(label)) return '';
  return label;
}

export function resolveNdisSupportDeliveredDates({
  jobStatus,
  scheduledStart,
  scheduledEnd,
  actualStart,
  actualEnd,
  formatDate = formatDdMmYyyy,
}) {
  const isCancelled = isCancelledShiftStatus(jobStatus);
  const startRaw = isCancelled
    ? (scheduledStart || actualStart)
    : (actualStart || scheduledStart);
  const endRaw = isCancelled
    ? (scheduledEnd || actualEnd)
    : (actualEnd || scheduledEnd);
  return {
    supportDeliveredFrom: formatDate(startRaw),
    supportDeliveredTo: formatDate(endRaw),
  };
}

export function isCancellationClaimRow(claimType, rowCode = '') {
  if (String(claimType || '').trim().toUpperCase() === 'CANC') return true;
  return String(rowCode || '').startsWith('canc_');
}

export function isTelehealthServiceMode(serviceDeliveryModeValue) {
  const label = formatLabelValue(serviceDeliveryModeValue).trim().toLowerCase();
  if (!label) return false;
  return /\btelehealth\b|\bthlt\b/.test(label);
}

export function resolveNdisClaimType(baseClaimType, serviceDeliveryModeValue, rowCode = '', itemNumber = '') {
  const normalizedBase = String(baseClaimType || '').trim().toUpperCase();
  if (normalizedBase) return normalizedBase;

  if (itemNumber) {
    const upper = String(itemNumber).toUpperCase().trim();
    if (upper.endsWith('_TH')) return 'THLT';
    if (upper.endsWith('_NF')) return 'NF2F';
    if (upper.endsWith('_RR')) return 'RR';
    if (upper.endsWith('_PT')) return 'PT';
  }

  if (!isTelehealthServiceMode(serviceDeliveryModeValue)) return '';

  const eligibleTelehealthCodes = new Set([
    'direct_support_time',
    'direct_support_non_time',
    'centre_capital_costs',
    'support',
    'support_non_time',
  ]);
  return eligibleTelehealthCodes.has(String(rowCode || '').trim()) ? 'THLT' : '';
}

function formatDateTimeForDesc(value, timeZone = SYDNEY_TIME_ZONE) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone });
}

export function isHourUnitLabel(unit) {
  if (!unit) return false;
  return String(unit).trim().toLowerCase().includes('hour');
}

export function isCompletedShiftStatus(jobStatus) {
  return String(jobStatus || '').trim().toLowerCase() === 'completed';
}

export function isCancelledShiftStatus(jobStatus) {
  return String(jobStatus || '').trim().toLowerCase() === 'cancelled';
}

function getShiftTimeRange(jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd) {
  if (isCompletedShiftStatus(jobStatus)) {
    return { startRaw: actualStart, endRaw: actualEnd };
  }
  if (isCancelledShiftStatus(jobStatus)) {
    return { startRaw: scheduledStart, endRaw: scheduledEnd };
  }
  return { startRaw: null, endRaw: null };
}

function appendHourUnitTimeRange(desc, unit, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd, timeZone) {
  if (!isHourUnitLabel(unit)) return desc;
  const { startRaw, endRaw } = getShiftTimeRange(jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd);
  const startTime = formatDateTimeForDesc(startRaw, timeZone);
  const endTime = formatDateTimeForDesc(endRaw, timeZone);
  if (!startTime || !endTime) return desc;
  return `${desc ? `${desc} - ` : ''}from ${startTime} to ${endTime}`;
}

export function buildServiceItemDescription({
  itemNumber,
  itemName,
  unit,
  jobStatus,
  actualStart,
  actualEnd,
  scheduledStart,
  scheduledEnd,
  fallback,
  groupSize,
  timeZone = SYDNEY_TIME_ZONE,
}) {
  let desc = itemName || '';
  if (itemNumber) desc += `${desc ? ' - ' : ''}${itemNumber}`;
  desc = appendHourUnitTimeRange(desc, unit, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd, timeZone);
  if (!desc) desc = fallback || 'Service';
  if (groupSize && Number(groupSize) !== 1) desc += ` - Group Size: ${groupSize}`;
  return desc;
}

function buildDirectSupportDesc({ itemNumber, itemName, startTime, endTime, groupSize, fallback, unit, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd, timeZone }) {
  if (unit !== undefined || jobStatus !== undefined) {
    return buildServiceItemDescription({
      itemNumber,
      itemName,
      unit: unit || 'Hour(H)',
      jobStatus,
      actualStart,
      actualEnd,
      scheduledStart,
      scheduledEnd,
      fallback: fallback || 'Direct Support',
      groupSize,
      timeZone,
    });
  }
  let desc = itemName || '';
  if (itemNumber) desc += `${desc ? ' - ' : ''}${itemNumber}`;
  if (startTime && endTime) desc += `${desc ? ' - ' : ''}from ${startTime} to ${endTime}`;
  if (!desc) desc = fallback || 'Direct Support';
  if (groupSize && Number(groupSize) !== 1) desc += ` - Group Size: ${groupSize}`;
  return desc;
}

function buildSimpleItemDesc({ itemNumber, itemName, fallback, unit, jobStatus, actualStart, actualEnd, scheduledStart, scheduledEnd, timeZone }) {
  if (unit !== undefined || jobStatus !== undefined) {
    return buildServiceItemDescription({
      itemNumber,
      itemName,
      unit,
      jobStatus,
      actualStart,
      actualEnd,
      scheduledStart,
      scheduledEnd,
      fallback: fallback || 'Service',
      timeZone,
    });
  }
  let desc = itemName || '';
  if (itemNumber) desc += `${desc ? ' - ' : ''}${itemNumber}`;
  if (!desc) desc = fallback || 'Service';
  return desc;
}

export function buildLegacyNdisMasterPlanServiceRows(args) {
  return buildLegacyNdisMasterPlanServiceRowsImpl(args);
}


export function collectNdisSupportCatalogueRefIds(servicePlanData, pricingRule = 'legacy') {
  if (!servicePlanData || typeof servicePlanData !== 'object') return [];
  const ids = [];
  const addId = (value) => {
    const id = extractRefId(value);
    if (id && isUuidLike(id)) ids.push(id);
  };

  const useNew = pricingRule === 'new';

  if (useNew) {
    addId(servicePlanData[NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT]);
    addId(servicePlanData[NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR]);
    addId(servicePlanData[NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME]);
    addId(servicePlanData[NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION]);
    addId(servicePlanData[NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT]);
    return ids;
  }

  addId(servicePlanData[NDIS_SERVICEPLAN_ATTR.ITEM_DIRECT_SUPPORT]);
  addId(servicePlanData[NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR]);
  addId(servicePlanData[NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT]);
  addId(servicePlanData[NDIS_SERVICEPLAN_ATTR.ITEM_CENTRE_CAPITAL]);
  return ids;
}

function resolveRefItem(refItemsMap, data, attr) {
  const id = extractRefId(data[attr]);
  return id ? refItemsMap.get(id) : null;
}

function buildNewNdisSupportCatalogue(data, refItemsMap) {
  return {
    support: resolveRefItem(refItemsMap, data, NDIS_SERVICEPLAN_ATTR.ITEM_SUPPORT),
    providerTravelNonLabour: resolveRefItem(refItemsMap, data, NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR),
    labourTravelTime: resolveRefItem(refItemsMap, data, NDIS_SERVICEPLAN_ATTR.ITEM_LABOUR_TRAVEL_TIME),
    cancellation: resolveRefItem(refItemsMap, data, NDIS_SERVICEPLAN_ATTR.ITEM_CANCELLATION),
    activityTransport: resolveRefItem(refItemsMap, data, NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT),
  };
}

function buildLegacyNdisSupportCatalogue(data, refItemsMap) {
  return {
    directSupport: resolveRefItem(refItemsMap, data, NDIS_SERVICEPLAN_ATTR.ITEM_DIRECT_SUPPORT),
    providerTravelNonLabour: resolveRefItem(refItemsMap, data, NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR),
    activityTransport: resolveRefItem(refItemsMap, data, NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT),
    centreCapital: resolveRefItem(refItemsMap, data, NDIS_SERVICEPLAN_ATTR.ITEM_CENTRE_CAPITAL),
  };
}

export function buildNdisSupportCatalogueForServicePlan(servicePlanItem, refItemsMap, pricingRule = 'legacy') {
  if (!servicePlanItem?.data || !refItemsMap) return {};
  const data = servicePlanItem.data;
  return pricingRule === 'new'
    ? buildNewNdisSupportCatalogue(data, refItemsMap)
    : buildLegacyNdisSupportCatalogue(data, refItemsMap);
}

export function buildNdisMasterPlanServiceRows(args) {
  if (args?.pricingRule === 'new') {
    return buildNewNdisMasterPlanServiceRows(args);
  }
  return buildLegacyNdisMasterPlanServiceRows(args);
}

