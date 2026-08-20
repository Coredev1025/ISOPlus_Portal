import {
  addDays,
  addMonthsClamped,
  startOfDayInstant,
} from './automationScheduleHelpers.js';
import { previousMonthServiceDeliveryWindow } from './automationPreviousMonth.js';
import { MONTHS_PER_UNIT } from '../constants/automation.js';

/**
 * The calendar day `slot` falls on in `timezone`, as `YYYY-MM-DD`.
 *
 * 'en-CA' renders that shape directly, which is the same reason
 * services/scheduler/advance.js formats startDates this way. Reading the day
 * in the schedule's own zone is the whole point: formatting in UTC rolls the
 * calendar day backwards for any zone west of Greenwich, which would shift
 * every billing window by a day.
 */
function wallYmdKey(slot, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(slot));
}

function ymdKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Step one whole period backwards from the slot's calendar day.
 *
 * The arithmetic is automationScheduleHelpers' addDays/addMonthsClamped run
 * with a negative offset — the same functions computeNextRun steps forward
 * with, so a window can never disagree with the schedule that produced it.
 * addMonthsClamped's day clamp matters here too: one month back from 31 March
 * is 28/29 February, not 2/3 March.
 */
function previousPeriodStartYmd(ymd, every) {
  const n = Math.max(1, Number(every?.n ?? 1));
  const unit = String(every?.unit ?? 'month').toLowerCase();
  if (unit === 'day') return addDays(ymd, -n);
  if (unit === 'week') return addDays(ymd, -n * 7);
  const months = MONTHS_PER_UNIT[unit];
  if (months) return addMonthsClamped(ymd, -n * months, ymd.day);
  return addDays(ymd, -n);
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
  const slotKey = wallYmdKey(slot, timezone);
  const [year, month, day] = slotKey.split('-').map(Number);
  const start = startOfDayInstant(
    ymdKey(previousPeriodStartYmd({ year, month, day }, schedule.every)), timezone,
  );
  const slotStart = startOfDayInstant(slotKey, timezone);
  return {
    serviceDeliveryStart: start.toISOString(),
    serviceDeliveryEnd: new Date(slotStart.getTime() - 1).toISOString(),
  };
}
