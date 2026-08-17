import { startOfDayInstant } from './automationScheduleHelpers.js';
import { previousMonthServiceDeliveryWindow } from './automationPreviousMonth.js';
import { MONTHS_PER_UNIT } from '../constants/automation.js';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function ymdKey({ year, month, day }) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function wallYmd(slot, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(slot));
  return {
    year: Number(parts.find((part) => part.type === 'year').value),
    month: Number(parts.find((part) => part.type === 'month').value),
    day: Number(parts.find((part) => part.type === 'day').value),
  };
}

function subtractDays(ymd, days) {
  const utc = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  utc.setUTCDate(utc.getUTCDate() - days);
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function subtractMonths(ymd, months) {
  const utc = new Date(Date.UTC(ymd.year, ymd.month - 1, 1));
  utc.setUTCMonth(utc.getUTCMonth() - months);
  const year = utc.getUTCFullYear();
  const month = utc.getUTCMonth() + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(ymd.day, last) };
}

function previousPeriodStartYmd(ymd, every) {
  const n = Math.max(1, Number(every?.n ?? 1));
  const unit = String(every?.unit ?? 'month').toLowerCase();
  if (unit === 'day') return subtractDays(ymd, n);
  if (unit === 'week') return subtractDays(ymd, n * 7);
  const months = MONTHS_PER_UNIT[unit];
  if (months) return subtractMonths(ymd, n * months);
  return subtractDays(ymd, n);
}

/**
 * Invoice Generator Service Delivery Date bounds for the period that just
 * ended at the claimed slot, in the schedule timezone.
 *
 * Touchpoints: services/automation/generateDocuments.js.
 */
export function schedulePeriodServiceDeliveryWindow(slot, timezone, schedule) {
  if (!schedule?.every) {
    return previousMonthServiceDeliveryWindow(slot, timezone);
  }
  const slotDay = wallYmd(slot, timezone);
  const start = startOfDayInstant(ymdKey(previousPeriodStartYmd(slotDay, schedule.every)), timezone);
  const slotStart = startOfDayInstant(ymdKey(slotDay), timezone);
  return {
    serviceDeliveryStart: start.toISOString(),
    serviceDeliveryEnd: new Date(slotStart.getTime() - 1).toISOString(),
  };
}
