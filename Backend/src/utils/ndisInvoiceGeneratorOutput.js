import {
  formatLabelValue,
  getValue,
  isCompletedShiftStatus,
  isHourUnitLabel,
} from './ndisServiceRecords.js';

const SYDNEY_TIME_ZONE = 'Australia/Sydney';

const SHIFT_STATUS_KEYS = ['Shift Status', 'ShiftStatus', 'Job Status', 'Job status', 'JobStatus'];
const ACTUAL_START_KEYS = ['Actual Shift Start Date and Time', 'Actual Shift Start Date & Time'];
const ACTUAL_END_KEYS = ['Actual Shift End Date and Time', 'Actual Shift End Date & Time'];

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

  return candidates.find(isCompletedShiftStatus) || candidates[0] || '';
}

function enrichRowDescription(row, masterPlanItem, timeZone) {
  if (!row || !masterPlanItem || !isHourUnitLabel(row.unit)) return row?.service || '';

  const shiftStatus = resolveShiftStatus(masterPlanItem);
  if (!isCompletedShiftStatus(shiftStatus)) return row.service || '';

  const itemNumber = (row.supportNumber || '').toString().trim();
  const startRaw = readItemField(masterPlanItem, ACTUAL_START_KEYS);
  const endRaw = readItemField(masterPlanItem, ACTUAL_END_KEYS);
  const start = formatDateTimeForDesc(startRaw, timeZone);
  const end = formatDateTimeForDesc(endRaw, timeZone);
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

export function buildMasterItemsMap(masterItems) {
  return new Map(
    (masterItems || [])
      .filter((item) => item?.itemId)
      .map((item) => [String(item.itemId), item]),
  );
}
