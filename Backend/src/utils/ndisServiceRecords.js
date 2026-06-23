const SYDNEY_TIME_ZONE = 'Australia/Sydney';

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

export function formatDurationHhhMm(value, source = 'hours') {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return '';

    // Accept preformatted duration strings and trim optional seconds.
    const timeMatch = s.match(/^(\d+):(\d{1,2})(?::\d{1,2})?$/);
    if (timeMatch) {
      const h = Number(timeMatch[1]);
      const m = Number(timeMatch[2]);
      if (Number.isFinite(h) && Number.isFinite(m) && m >= 0 && m < 60) {
        return `${h}:${String(m).padStart(2, '0')}`;
      }
    }

    const n = Number(s);
    if (!Number.isFinite(n)) return '';
    return source === 'minutes' ? minutesToHhhMm(n) : hoursToHhhMm(n);
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
  if (s.includes('family') || s.includes('emergency')) return 'NSDF';
  if (s.includes('transport')) return 'NSDT';
  return 'NSDO';
}

export function isTelehealthServiceMode(serviceDeliveryModeValue) {
  const label = formatLabelValue(serviceDeliveryModeValue).trim().toLowerCase();
  if (!label) return false;
  return /\btelehealth\b|\bthlt\b/.test(label);
}

export function resolveNdisClaimType(baseClaimType, serviceDeliveryModeValue, rowCode = '') {
  const normalizedBase = String(baseClaimType || '').trim().toUpperCase();
  if (normalizedBase) return normalizedBase;

  if (!isTelehealthServiceMode(serviceDeliveryModeValue)) return '';

  // THLT applies to direct service rows only when no stronger claim type is already set.
  const eligibleTelehealthCodes = new Set([
    'direct_support_time',
    'direct_support_non_time',
    'centre_capital_costs',
  ]);
  return eligibleTelehealthCodes.has(String(rowCode || '').trim()) ? 'THLT' : '';
}

function buildDirectSupportDesc({ itemNumber, itemName, startTime, endTime, groupSize, fallback }) {
  let desc = itemName || '';
  if (itemNumber) desc += `${desc ? ' - ' : ''}${itemNumber}`;
  if (startTime && endTime) desc += `${desc ? ' - ' : ''}from ${startTime} to ${endTime}`;
  if (!desc) desc = fallback || 'Direct Support';
  if (groupSize && Number(groupSize) !== 1) desc += ` - Group Size: ${groupSize}`;
  return desc;
}

function buildSimpleItemDesc({ itemNumber, itemName, fallback }) {
  let desc = itemName || '';
  if (itemNumber) desc += `${desc ? ' - ' : ''}${itemNumber}`;
  if (!desc) desc = fallback || 'Service';
  return desc;
}

function formatDateTimeForDesc(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function buildNdisMasterPlanServiceRows({
  masterPlanItem,
  participantName,
  participantProfileItem,
  servicePlanItem,
  supportCatalogue,
  cancellationTypeItem,
  invoiceNumber,
  invoicePdfLink,
}) {
  const rows = [];
  const itemId = masterPlanItem?.itemId;
  const master = masterPlanItem?.data || {};

  const groupSize = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.GROUP_SIZE]) || 1;
  const jobStatus = getMasterPlanLabel(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.JOB_STATUS,
    'Shift Status',
    'Job status',
    'JobStatus',
    'ShiftStatus',
  ]);
  const paymentStatus = getMasterPlanLabel(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.PAYMENT_STATUS,
    'Payment status',
    'PaymentStatus',
  ]);

  const scheduledStart = master[NDIS_MASTERPLAN_ATTR.SCHEDULED_START];
  const scheduledEnd = getValueMulti(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.SCHEDULED_END,
    'Scheduled Shift End Date and Time',
    'Scheduled Shift End Date & Time',
  ]);
  const actualStart = getValueMulti(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.ACTUAL_START,
    'Actual Shift Start Date & Time',
  ]);
  const actualEnd = getValueMulti(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.ACTUAL_END,
    'Actual Shift End Date & Time',
  ]);

  const computeDurationHr = (startRaw, endRaw) => {
    if (!startRaw || !endRaw) return 0;
    const s = new Date(startRaw);
    const e = new Date(endRaw);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
    const ms = e.getTime() - s.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return ms / (60 * 60 * 1000);
  };

  let actualDurationHr = getMasterPlanNumber(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.ACTUAL_DURATION_HR,
    'Actual Shift Duration (Hr.)',
    'Actual Shift Duration (Hr)',
    'Actual Shift Duration(Hrs.)',
    'Actual Shift Duration (Hrs.)',
    'Actual Shift Duration',
  ]);
  if (actualDurationHr <= 0) {
    actualDurationHr = computeDurationHr(actualStart, actualEnd);
  }

  let scheduledDurationHr = getMasterPlanNumber(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.SCHEDULED_DURATION_HR,
    'Scheduled Shift Duration (Hr.)',
    'Scheduled Shift Duration (Hr)',
    'Scheduled Shift Duration(Hrs.)',
    'Scheduled Shift Duration',
  ]);
  if (scheduledDurationHr <= 0) {
    scheduledDurationHr = computeDurationHr(scheduledStart, scheduledEnd);
  }

  const scheduledServiceDate = getDateOnlyIso(scheduledStart);
  const serviceDeliveryDate = getDateOnlyIso(actualStart);

  const status = invoiceNumber ? 'invoiced' : 'pending';

  const servicePlan = servicePlanItem || null;
  const spDirectUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_DIRECT_SUPPORT,
    'Unit (Direct Support)',
  ]);
  const spDirectUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_DIRECT_SUPPORT,
    'Agreed Unit Price for Direct Support ($)',
    'Agreed Unit Price for Direct Support($)',
  ]);
  const spNonLabourUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_PROVIDER_TRAVEL_NON_LABOUR,
    'Unit (Provider Travel Non-Labour Cost)',
    'Unit (Provider Travel - Non-Labour Costs)',
  ]);
  const spNonLabourUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_PROVIDER_TRAVEL_NON_LABOUR,
    'Agreed Unit Price for Non-Labour Travel ($)',
    'Agreed Unit Price for Non-Labour Travel($)',
  ]);
  const spActivityUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_ACTIVITY_TRANSPORT,
    'Unit (Activity Base Transport)',
  ]);
  const spActivityUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_ACTIVITY_TRANSPORT,
    'Agreed Price for Activity Base Transport ($)',
    'Agreed Unit Price for Activity Based Transport ($)',
  ]);
  const spCentreUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_CENTRE_CAPITAL,
    'Unit (Centre Capital Cost)',
    'Unit (Centre Capital Costs)',
  ]);
  const spCentreUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_CENTRE_CAPITAL,
    'Agreed Unit Price for Centre Capital Cost($)',
    'Agreed Unit Price for Centre Capital Costs ($)',
    'Agreed Unit Price for Centre Capital Costs($)',
  ]);
  const spLabourUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_LABOUR_TRAVEL_TIME,
    'Unit (Labour Travel Time)',
  ]);
  const spLabourUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_LABOUR_TRAVEL_TIME,
    'Agreed Unit Price for Labour Travel Time ($)',
    'Agreed Unit Price for Labour Travel Time($)',
  ]);
  const spAllowancesUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_ALLOWANCES,
    'Unit (Allowances)',
  ]);
  const spNonFaceUnit = getServicePlanLabel(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.UNIT_NON_FACE_TO_FACE,
    'Unit (Non Face to Face Support)',
  ]);
  const spNonFaceUnitPrice = getServicePlanNumber(servicePlan, [
    NDIS_SERVICEPLAN_ATTR.PRICE_NON_FACE_TO_FACE,
    'Agreed Unit Price for Non-Face-to-Face Support($)',
    'Agreed Unit Price for Non Face to Face Support($)',
    'Agreed Unit Price for Non-Face-to-Face Support ($)',
  ]);

  const directSupportItemNumber = getSupportItemNumber(
    supportCatalogue?.directSupport,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_DIRECT_SUPPORT)
  );
  const directSupportItemName = getSupportItemName(supportCatalogue?.directSupport, '');

  const providerTravelItemNumber = getSupportItemNumber(
    supportCatalogue?.providerTravelNonLabour,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_PROVIDER_TRAVEL_NON_LABOUR)
  );
  const providerTravelItemName = getSupportItemName(supportCatalogue?.providerTravelNonLabour, '');

  const activityItemNumber = getSupportItemNumber(
    supportCatalogue?.activityTransport,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_ACTIVITY_TRANSPORT)
  );
  const activityItemName = getSupportItemName(supportCatalogue?.activityTransport, '');

  const centreCapitalItemNumber = getSupportItemNumber(
    supportCatalogue?.centreCapital,
    getValue(servicePlan, NDIS_SERVICEPLAN_ATTR.ITEM_CENTRE_CAPITAL)
  );
  const centreCapitalItemName = getSupportItemName(supportCatalogue?.centreCapital, '');

  const actualStartDesc = formatDateTimeForDesc(actualStart);
  const actualEndDesc = formatDateTimeForDesc(actualEnd);
  const serviceDeliveryModeValue = getValueMulti(masterPlanItem, [
    NDIS_MASTERPLAN_ATTR.SERVICE_DELIVERY_MODE,
    'Service Delivery Mode',
  ]);

  const addRow = (row) => {
    const claimType = resolveNdisClaimType(row.claimType, serviceDeliveryModeValue, row.code);
    rows.push({
      id: `${itemId}:${row.code}`,
      sourceItemId: itemId,
      status,
      participant: participantName || getParticipantDisplayName(participantProfileItem) || String(master[NDIS_MASTERPLAN_ATTR.PARTICIPANT_FULL_NAME] || ''),
      scheduledServiceDate,
      serviceDeliveryDate,
      jobStatus,
      paymentStatus,
      invoiceNumber,
      fileUrl: invoicePdfLink || null,
      gst: row.gst ?? 'GST Free',
      ...row,
      claimType,
    });
  };

  const isCancelled = jobStatus.toLowerCase() === 'cancelled';

  if (!isCancelled) {
    // 1) Direct Support - Hour based
    const directTimeAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_TIME]);
    if (directTimeAmount > 0 && spDirectUnit.includes('Hour')) {
      let unitPrice = groupSize > 0 ? spDirectUnitPrice / groupSize : 0;
      let qty = round1(actualDurationHr);
      // If duration is not stored, derive qty from amount/unit price (matches NDIS invoice output)
      if (qty <= 0 && directTimeAmount > 0 && unitPrice > 0) {
        qty = round1(directTimeAmount / unitPrice);
      }
      // If unit price is missing but qty exists, derive unit price from amount/qty
      if (unitPrice <= 0 && directTimeAmount > 0 && qty > 0) {
        unitPrice = parseFloat((directTimeAmount / qty).toFixed(2));
      }

      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'direct_support_time',
          service: buildDirectSupportDesc({
            itemNumber: directSupportItemNumber,
            itemName: directSupportItemName,
            startTime: actualStartDesc,
            endTime: actualEndDesc,
            groupSize,
            fallback: 'Direct Support - Hour based',
          }),
          unit: spDirectUnit || 'Hour(H)',
          quantity: qty,
          unitPrice,
          totalAmount: directTimeAmount,
          supportNumber: directSupportItemNumber,
          claimType: '',
        });
      }
    }

    // 2) Direct Support - Non hour based
    const directNonTimeAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.DIRECT_SUPPORT_VALUE_NON_TIME]);
    if (directNonTimeAmount > 0 && !spDirectUnit.includes('Hour')) {
      let qty = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.QUANTITY_DIRECT_SUPPORT_NON_TIME]);
      let unitPrice = spDirectUnitPrice;
      if (qty <= 0 && directNonTimeAmount > 0 && unitPrice > 0) {
        qty = parseNumberValue(parseFloat((directNonTimeAmount / unitPrice).toFixed(2)));
      }
      if (unitPrice <= 0 && directNonTimeAmount > 0 && qty > 0) {
        unitPrice = parseFloat((directNonTimeAmount / qty).toFixed(2));
      }

      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'direct_support_non_time',
          service: (() => {
            let desc = buildSimpleItemDesc({
              itemNumber: directSupportItemNumber,
              itemName: directSupportItemName,
              fallback: 'Direct Support - NOT Hour based',
            });
            if (qty && spDirectUnit) desc += ` - ${qty} ${spDirectUnit}`;
            return desc;
          })(),
          unit: spDirectUnit || '',
          quantity: qty,
          unitPrice,
          totalAmount: directNonTimeAmount,
          supportNumber: directSupportItemNumber,
          claimType: '',
        });
      }
    }

    // 3) Provider Travel - Non-Labour Cost (unitPrice=1, quantity=amount)
    let providerAmount = getMasterPlanNumber(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_NON_LABOUR_AMOUNT,
      'Provider Travel - Non-Labour Amount($)',
      'Provider Travel - Non-Labour Cost Amount ($)',
    ]);
    const providerMileageRaw = getValueMulti(masterPlanItem, [
        NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_MILEAGE,
        'Provider Travel - Non-Labour Mileage (kms) as per the Service Plan, if a vehicle is used.',
      ]);
    const providerOthersRaw = getValueMulti(masterPlanItem, [
        NDIS_MASTERPLAN_ATTR.PROVIDER_TRAVEL_OTHER_COSTS,
        'Provider Travel - Non-Labour - Other Costs as per the Service Plan, if other costs are applied.',
      ]);
    const providerMileageNum = parseNumberValue(providerMileageRaw);
    const providerOthersNum = parseNumberValue(providerOthersRaw);
    if (providerAmount <= 0) {
      const computed =
        providerMileageNum > 0 && spNonLabourUnitPrice > 0
          ? providerMileageNum * spNonLabourUnitPrice + providerOthersNum
          : providerOthersNum;
      if (computed > 0) providerAmount = computed;
    }

    if (providerAmount > 0) {
      addRow({
        code: 'provider_travel_non_labour',
        service: (() => {
          let desc = buildSimpleItemDesc({
            itemNumber: providerTravelItemNumber,
            itemName: providerTravelItemName,
            fallback: 'Provider Travel - Non-Labour Cost Item',
          });
          if (providerMileageNum) desc += ` - ${providerMileageNum}km`;
          if (providerOthersNum) desc += ` - Others: ${providerOthersNum}`;
          return desc;
        })(),
        unit: spNonLabourUnit || '',
        quantity: providerAmount,
        unitPrice: 1,
        totalAmount: providerAmount,
        supportNumber: providerTravelItemNumber,
        claimType: '',
      });
    }

    // 4) Activity Based Transport (unitPrice=1, quantity=amount)
    let activityAmount = getMasterPlanNumber(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.ACTIVITY_BASE_TRANSPORT_AMOUNT,
      'Activity Based Transport Amount($)',
      'Activity Based Transport Amount ($)',
      'Activity Base Transport Amount ($)',
    ]);
    const activityMileageRaw = getValueMulti(masterPlanItem, [
        NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_MILEAGE,
        'Activity Based Transport Mileage(Kms) as per the Service Plan, if a vehicle is used.',
      ]);
    const activityOthersRaw = getValueMulti(masterPlanItem, [
        NDIS_MASTERPLAN_ATTR.ACTIVITY_TRANSPORT_OTHER_COSTS,
        'Activity Based Transport Costs as per the Service Plan, if other costs are applied.',
      ]);
    const activityMileageNum = parseNumberValue(activityMileageRaw);
    const activityOthersNum = parseNumberValue(activityOthersRaw);
    if (activityAmount <= 0) {
      const computed =
        activityMileageNum > 0 && spActivityUnitPrice > 0
          ? activityMileageNum * spActivityUnitPrice + activityOthersNum
          : activityOthersNum;
      if (computed > 0) activityAmount = computed;
    }

    if (activityAmount > 0) {
      addRow({
        code: 'activity_transport',
        service: (() => {
          let desc = buildSimpleItemDesc({
            itemNumber: activityItemNumber,
            itemName: activityItemName,
            fallback: 'Activity Based Transport Item',
          });
          if (activityMileageNum) desc += ` - ${activityMileageNum}km`;
          if (activityOthersNum) desc += ` - Others: ${activityOthersNum}`;
          return desc;
        })(),
        unit: spActivityUnit || 'Each(E)',
        quantity: activityAmount,
        unitPrice: 1,
        totalAmount: activityAmount,
        supportNumber: activityItemNumber,
        claimType: '',
      });
    }

    // 5) Centre Capital Costs
    let centreAmount = getMasterPlanNumber(masterPlanItem, [
      NDIS_MASTERPLAN_ATTR.CENTRE_CAPITAL_COSTS_AMOUNT,
      'Centre Capital Cost Amount($)',
      'Centre Capital Cost Amount ($)',
      'Centre Capital Costs Amount ($)',
    ]);
    // Prefer actual duration, but if it's missing use qty = amount / unitPrice
    // (this matches the NDIS PDF invoice output where Centre Capital quantity is still shown).
    let qty = round1(actualDurationHr);
    let unitPrice = spCentreUnitPrice;
    if (qty <= 0 && centreAmount > 0 && unitPrice > 0) {
      qty = round1(centreAmount / unitPrice);
    }
    if (unitPrice <= 0 && centreAmount > 0 && qty > 0) {
      unitPrice = parseFloat((centreAmount / qty).toFixed(2));
    }
    if (centreAmount <= 0 && qty > 0 && unitPrice > 0) {
      centreAmount = qty * unitPrice;
    }

    if (centreAmount > 0) {
      if (qty > 0 && unitPrice > 0) {
        addRow({
          code: 'centre_capital_costs',
          service: buildSimpleItemDesc({
            itemNumber: centreCapitalItemNumber,
            itemName: centreCapitalItemName,
            fallback: 'Centre Capital Costs Item',
          }),
          unit: spCentreUnit || 'Hour(H)',
          quantity: qty,
          unitPrice,
          totalAmount: centreAmount,
          supportNumber: centreCapitalItemNumber,
          claimType: '',
        });
      }
    }

    // 6) Labour Travel Time (quantity=minutes)
    const labourAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_AMOUNT]);
    if (labourAmount > 0) {
      const qty = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.LABOUR_TRAVEL_TIME_MIN]);
      if (qty > 0 && spLabourUnitPrice > 0) {
        addRow({
          code: 'labour_travel_time',
          service: 'Provider Travel - Labour Travel Time Costs',
          unit: spLabourUnit || '',
          quantity: qty,
          unitPrice: spLabourUnitPrice,
          totalAmount: labourAmount,
          supportNumber: directSupportItemNumber,
          claimType: 'TRAN',
        });
      }
    }

    // 7) Allowances (quantity=1, unitPrice=Used Allowance Amount)
    const allowancesAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.ALLOWANCES_AMOUNT]);
    if (allowancesAmount > 0) {
      const usedAllowanceUnitPrice = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.USED_ALLOWANCE_AMOUNT]) || allowancesAmount;
      const allowancesType = formatLabelValue(master[NDIS_MASTERPLAN_ATTR.ALLOWANCES_TYPE]).trim();
      const allowancesTypeLower = allowancesType.toLowerCase();
      const isNdiaRequiredReport =
        allowancesTypeLower.includes('report') &&
        (allowancesTypeLower.includes('ndia') ||
          allowancesTypeLower.includes('required') ||
          allowancesTypeLower.includes('requested') ||
          allowancesTypeLower.includes('mandatory'));
      addRow({
        code: 'allowances',
        service: `Allowances${allowancesType ? ` - ${allowancesType}` : ''}`,
        unit: spAllowancesUnit || '',
        quantity: 1,
        unitPrice: usedAllowanceUnitPrice,
        totalAmount: allowancesAmount,
        supportNumber: directSupportItemNumber,
        claimType: isNdiaRequiredReport ? 'REPW' : '',
      });
    }

    // 8) Non-Face-to-Face Support (quantity=hours)
    const nonFaceAmount = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_AMOUNT]);
    if (nonFaceAmount > 0) {
      const qty = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_TIME_HR]);
      const nf2fType = formatLabelValue(master[NDIS_MASTERPLAN_ATTR.NON_FACE_TO_FACE_SUPPORTS]).trim();
      if (qty > 0 && spNonFaceUnitPrice > 0) {
        addRow({
          code: 'non_face_to_face',
          service: `Non-Face-to-Face Support${nf2fType ? ` - ${nf2fType}` : ''}`,
          unit: spNonFaceUnit || '',
          quantity: qty,
          unitPrice: spNonFaceUnitPrice,
          totalAmount: nonFaceAmount,
          supportNumber: directSupportItemNumber,
          claimType: 'NF2F',
        });
      }
    }
  } else {
    const cancellationFee = parseNumberValue(master[NDIS_MASTERPLAN_ATTR.CANCELLATION_FEE]);
    if (cancellationFee > 0) {
      const billablePct = parseNumberValue(getValue(cancellationTypeItem, NDIS_CANCELLATION_TYPE_ATTR.BILLABLE_TO_CLIENT_PCT));
      const scheduledDuration = round1(scheduledDurationHr);

      const directShortNotice = getShortNoticeCancellationsFlag(supportCatalogue?.directSupport);
      const providerShortNotice = getShortNoticeCancellationsFlag(supportCatalogue?.providerTravelNonLabour);
      const activityShortNotice = getShortNoticeCancellationsFlag(supportCatalogue?.activityTransport);
      const centreShortNotice = getShortNoticeCancellationsFlag(supportCatalogue?.centreCapital);

      if (directShortNotice) {
        const qty = spDirectUnit.includes('Hour')
          ? scheduledDuration
          : parseNumberValue(master[NDIS_MASTERPLAN_ATTR.QUANTITY_DIRECT_SUPPORT_NON_TIME]);
        const baseUnitPrice = spDirectUnit.includes('Hour')
          ? (groupSize > 0 ? spDirectUnitPrice / groupSize : 0)
          : spDirectUnitPrice;
        const unitPriceRaw = baseUnitPrice * (billablePct / 100);
        const unitPrice = parseFloat(unitPriceRaw.toFixed(2));
        const totalAmount = parseFloat((qty * unitPrice).toFixed(2));
        if (qty > 0 && unitPrice > 0) {
          addRow({
            code: 'canc_direct_support',
            service: (() => {
              let desc = 'Cancellation Fee';
              if (directSupportItemName) desc += ` - ${directSupportItemName}`;
              if (directSupportItemNumber) desc += ` - ${directSupportItemNumber}`;
              if (billablePct) desc += ` - ${billablePct}%`;
              if (groupSize !== 1) desc += ` - Group Size: ${groupSize}`;
              return desc;
            })(),
            unit: spDirectUnit || '',
            quantity: qty,
            unitPrice,
            totalAmount,
            supportNumber: directSupportItemNumber,
            claimType: 'CANC',
          });
        }
      }

      if (providerShortNotice) {
        const qty = scheduledDuration;
        const unitPriceRaw = spNonLabourUnitPrice * (billablePct / 100);
        const unitPrice = parseFloat(unitPriceRaw.toFixed(2));
        const totalAmount = parseFloat((qty * unitPrice).toFixed(2));
        if (qty > 0 && unitPrice > 0) {
          addRow({
            code: 'canc_provider_travel',
            service: (() => {
              let desc = 'Cancellation Fee';
              if (providerTravelItemName) desc += ` - ${providerTravelItemName}`;
              if (providerTravelItemNumber) desc += ` - ${providerTravelItemNumber}`;
              if (billablePct) desc += ` - ${billablePct}%`;
              return desc;
            })(),
            unit: spNonLabourUnit || '',
            quantity: qty,
            unitPrice,
            totalAmount,
            supportNumber: providerTravelItemNumber,
            claimType: 'CANC',
          });
        }
      }

      if (activityShortNotice) {
        const qty = scheduledDuration;
        const unitPriceRaw = spActivityUnitPrice * (billablePct / 100);
        const unitPrice = parseFloat(unitPriceRaw.toFixed(2));
        const totalAmount = parseFloat((qty * unitPrice).toFixed(2));
        if (qty > 0 && unitPrice > 0) {
          addRow({
            code: 'canc_activity_transport',
            service: (() => {
              let desc = 'Cancellation Fee';
              if (activityItemName) desc += ` - ${activityItemName}`;
              if (activityItemNumber) desc += ` - ${activityItemNumber}`;
              if (billablePct) desc += ` - ${billablePct}%`;
              return desc;
            })(),
            unit: spActivityUnit || '',
            quantity: qty,
            unitPrice,
            totalAmount,
            supportNumber: activityItemNumber,
            claimType: 'CANC',
          });
        }
      }

      if (centreShortNotice) {
        const qty = scheduledDuration;
        const unitPriceRaw = spCentreUnitPrice * (billablePct / 100);
        const unitPrice = parseFloat(unitPriceRaw.toFixed(2));
        const totalAmount = parseFloat((qty * unitPrice).toFixed(2));
        if (qty > 0 && unitPrice > 0) {
          addRow({
            code: 'canc_centre_capital',
            service: (() => {
              let desc = 'Cancellation Fee';
              if (centreCapitalItemName) desc += ` - ${centreCapitalItemName}`;
              if (centreCapitalItemNumber) desc += ` - ${centreCapitalItemNumber}`;
              if (billablePct) desc += ` - ${billablePct}%`;
              return desc;
            })(),
            unit: spCentreUnit || '',
            quantity: qty,
            unitPrice,
            totalAmount,
            supportNumber: centreCapitalItemNumber,
            claimType: 'CANC',
          });
        }
      }
    }
  }

  return rows;
}

