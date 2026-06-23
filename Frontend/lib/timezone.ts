function getUtcOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at.getTime();
}

export function getDateOnlyInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function dateOnlyToStartOfDayISO(yyyyMmDd: string, timeZone: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const offsetMs = getUtcOffsetMs(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)), timeZone);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs).toISOString();
}

export function dateOnlyToEndOfDayISO(yyyyMmDd: string, timeZone: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const offsetMs = getUtcOffsetMs(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)), timeZone);
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - offsetMs).toISOString();
}

export function dateToStartOfDayISO(date: Date, timeZone: string): string {
  return dateOnlyToStartOfDayISO(getDateOnlyInTimeZone(date, timeZone), timeZone);
}

export function dateToEndOfDayISO(date: Date, timeZone: string): string {
  return dateOnlyToEndOfDayISO(getDateOnlyInTimeZone(date, timeZone), timeZone);
}

export function formatDateDDMMYYYY(value: string | null | undefined, timeZone: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export function formatDateTimeDDMMYYYY(value: string | null | undefined, timeZone: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("day"), month = get("month"), year = get("year");
  const hour = get("hour"), minute = get("minute");
  return day && month && year ? `${day}/${month}/${year} ${hour}:${minute}` : "";
}

export function formatDateOnlyYYYYMMDD(value: string | null | undefined, timeZone: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function getMonthBoundaryDates(year: number, month: number): { firstDay: string; lastDay: string } {
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    firstDay: `${year}-${pad(month)}-01`,
    lastDay: `${year}-${pad(month)}-${pad(lastDayOfMonth)}`,
  };
}
