import { DEFAULT_BUSINESS_TIMEZONE } from '@/constants/timezone';

export type SchedulePrevious = {
  at: string;
} | null;

export type ScheduleCurrent = {
  state: string;
  syncType?: string;
} | null;

export type ScheduleUpcoming = {
  at: string;
} | null;

export type BoardSyncSchedule = {
  cron?: string | null;
  timezone?: string | null;
  previous: SchedulePrevious;
  current: ScheduleCurrent;
  upcoming: ScheduleUpcoming;
};

const CURRENT_LABELS: Record<string, string> = {
  waiting: 'Queued',
  delayed: 'Queued',
  active: 'In progress',
  'in-progress': 'In progress',
  started: 'In progress',
};

export function formatScheduleInstant(
  iso: string,
  timezone: string = DEFAULT_BUSINESS_TIMEZONE,
) {
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(iso));
}

export function labelInstant(
  entry: { at: string } | null | undefined,
  timezone: string | null | undefined,
  fallback: string,
) {
  return entry?.at
    ? formatScheduleInstant(entry.at, timezone || undefined)
    : fallback;
}

export function labelCurrentSync(current: ScheduleCurrent) {
  if (!current) return 'Idle';
  return CURRENT_LABELS[current.state] ?? current.state;
}
