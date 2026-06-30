import {
  formatLabelValue,
  getParticipantDisplayName,
  getParticipantNdisNumber,
  getValue,
  isCancelledShiftStatus,
  isCompletedShiftStatus,
  isHourUnitLabel,
} from './ndisServiceRecords.js';

const SYDNEY_TIME_ZONE = 'Australia/Sydney';

const SHIFT_STATUS_KEYS = ['Shift Status', 'ShiftStatus', 'Job Status', 'Job status', 'JobStatus'];
const DATE_KEYS = {
  actualStart: ['Actual Shift Start Date and Time', 'Actual Shift Start Date & Time'],
  actualEnd: ['Actual Shift End Date and Time', 'Actual Shift End Date & Time'],
  scheduledStart: ['Scheduled Shift Start Date & Time', 'Scheduled Shift Start Date and Time'],
  scheduledEnd: ['Scheduled Shift End Date & Time', 'Scheduled Shift End Date and Time'],
};

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = (value ?? '').toString().trim();
    if (text) return text;
  }
  return '';
}

function readDataFields(data, ...keys) {
  if (!data) return '';
  for (const key of keys) {
    const text = formatLabelValue(data[key]).trim();
    if (text) return text;
  }
  return '';
}

function readItemField(item, keys) {
  if (!item?.data) return null;
  for (const key of keys) {
    const raw = getValue(item, key);
    if (raw === null || raw === undefined) continue;
    if (formatLabelValue(raw).trim()) return raw;
  }
  return null;
}

function formatDateTimeForDesc(value, timeZone = SYDNEY_TIME_ZONE) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-AU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

function resolveShiftStatus(masterPlanItem) {
  const data = masterPlanItem?.data || {};
  const candidates = SHIFT_STATUS_KEYS
    .map((key) => formatLabelValue(data[key]).trim())
    .filter(Boolean);

  return (
    candidates.find(isCancelledShiftStatus) ||
    candidates.find(isCompletedShiftStatus) ||
    candidates[0] ||
    ''
  );
}

function extractShiftTimes(masterPlanItem, shiftStatus, timeZone) {
  const keys = isCompletedShiftStatus(shiftStatus)
    ? [DATE_KEYS.actualStart, DATE_KEYS.actualEnd]
    : isCancelledShiftStatus(shiftStatus)
      ? [DATE_KEYS.scheduledStart, DATE_KEYS.scheduledEnd]
      : null;

  if (!keys) return { start: '', end: '' };

  const startRaw = readItemField(masterPlanItem, keys[0]);
  const endRaw = readItemField(masterPlanItem, keys[1]);
  return {
    start: formatDateTimeForDesc(startRaw, timeZone),
    end: formatDateTimeForDesc(endRaw, timeZone),
  };
}

function enrichRowDescription(row, masterPlanItem, timeZone) {
  if (!row || !masterPlanItem || !isHourUnitLabel(row.unit)) return row?.service || '';

  const shiftStatus = resolveShiftStatus(masterPlanItem);
  if (!isCompletedShiftStatus(shiftStatus) && !isCancelledShiftStatus(shiftStatus)) {
    return row.service || '';
  }

  const itemNumber = (row.supportNumber || '').toString().trim();
  const { start, end } = extractShiftTimes(masterPlanItem, shiftStatus, timeZone);
  if (!itemNumber || !start || !end || /\bfrom\s+.+\s+to\s+.+/i.test(row.service || '')) {
    return row.service || '';
  }

  const suffix = ` - from ${start} to ${end}`;
  const index = row.service.indexOf(itemNumber);
  if (index >= 0) {
    const insertAt = index + itemNumber.length;
    return `${row.service.slice(0, insertAt)}${suffix}${row.service.slice(insertAt)}`;
  }
  return `${row.service}${suffix}`;
}

export function enrichNdisInvoiceGeneratorRows(rows, masterItemsById, timeZone = SYDNEY_TIME_ZONE) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const masterPlanItem = masterItemsById.get(String(row.sourceItemId || ''));
    if (!masterPlanItem) return row;
    const service = enrichRowDescription(row, masterPlanItem, timeZone);
    return service === row.service ? row : { ...row, service };
  });
}

export function buildNdisInvoicePdfClientDetails({
  participantProfile = {},
  participantProfileItem = null,
  apiProfileValues = null,
  fallbackParticipantName = '',
} = {}) {
  const data = participantProfileItem?.data || {};
  const api = apiProfileValues || {};

  const participantName = firstNonEmpty(
    participantProfile.fullName,
    participantProfile.displayName,
    readDataFields(data, 'Full Name/Preferred Name', 'Preferred Name', 'Full Name', 'Name'),
    api.fullName,
    fallbackParticipantName,
    getParticipantDisplayName(participantProfileItem),
  );

  const contact = firstNonEmpty(
    participantProfile.billingContact,
    readDataFields(data, 'Billing Contact', 'Invoice To', 'Plan Manager'),
    api.billingContact,
    participantName,
  );

  const billingAddress = firstNonEmpty(
    participantProfile.billingAddress,
    api.billingAddress,
    readDataFields(data, 'Billing Address', 'Invoice Address'),
  );
  const street = firstNonEmpty(participantProfile.address, api.address, readDataFields(data, 'Address', 'Street Address'));
  const suburb = firstNonEmpty(participantProfile.suburb, api.suburb, readDataFields(data, 'Suburb'));
  const state = firstNonEmpty(participantProfile.state, api.state, readDataFields(data, 'State'));
  const postcode = firstNonEmpty(participantProfile.postcode, api.postcode, readDataFields(data, 'Postcode', 'Post Code'));
  const address = billingAddress || [street, suburb, [state, postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const ndisNumber = firstNonEmpty(getParticipantNdisNumber(participantProfileItem), readDataFields(data, 'NDIS Number', 'NDISNumber'));

  return {
    Contact: contact || ' ',
    Address: address || ' ',
    'Participant Name': participantName || contact || ' ',
    'NDIS Number': ndisNumber || ' ',
  };
}

export function buildNdisXeroInvoiceReference(participantProfile, participantProfileItem) {
  const name = firstNonEmpty(
    participantProfile?.fullName,
    participantProfile?.displayName,
    getParticipantDisplayName(participantProfileItem),
  );
  const ndisNumber = getParticipantNdisNumber(participantProfileItem);
  return [name, ndisNumber].filter(Boolean).join(' - ') || ' ';
}

export function buildMasterItemsMap(masterItems) {
  return new Map(
    (masterItems || [])
      .filter((item) => item?.itemId)
      .map((item) => [String(item.itemId), item]),
  );
}
