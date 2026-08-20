import { startOfDayInstant } from './automationScheduleHelpers.js';

export function previousCalendarMonth(slot, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(slot));
  const year = Number(parts.find((part) => part.type === 'year').value);
  const month = Number(parts.find((part) => part.type === 'month').value);
  const prev = month === 1
    ? { year: year - 1, month: 12 }
    : { year, month: month - 1 };
  const monthNumber = String(prev.month).padStart(2, '0');
  const monthLabel = new Date(Date.UTC(prev.year, prev.month - 1, 15))
    .toLocaleString('en-AU', { month: 'long' });
  return { year: String(prev.year), monthNumber, monthLabel };
}

function nextCalendarMonthStart(year, monthNumber, timezone) {
  const month = Number(monthNumber);
  if (month === 12) return startOfDayInstant(`${Number(year) + 1}-01-01`, timezone);
  return startOfDayInstant(`${year}-${String(month + 1).padStart(2, '0')}-01`, timezone);
}

/** Invoice Generator Service Delivery Date bounds for the previous calendar month. */
export function previousMonthServiceDeliveryWindow(slot, timezone) {
  const { year, monthNumber } = previousCalendarMonth(slot, timezone);
  const start = startOfDayInstant(`${year}-${monthNumber}-01`, timezone);
  const nextStart = nextCalendarMonthStart(year, monthNumber, timezone);
  return {
    serviceDeliveryStart: start.toISOString(),
    serviceDeliveryEnd: new Date(nextStart.getTime() - 1).toISOString(),
  };
}

