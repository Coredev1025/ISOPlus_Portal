import { DEFAULT_BUSINESS_TIMEZONE } from '@/constants/timezone';

export type SchedulePrevious = {
  at: string;
  status?: string;
  syncType?: string | null;
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

export function labelPreviousSync(
  previous: SchedulePrevious,
  timezone?: string | null,
) {
  if (!previous?.at) return 'None yet';
  return formatScheduleInstant(previous.at, timezone ?? DEFAULT_BUSINESS_TIMEZONE);
}

export function labelCurrentSync(current: ScheduleCurrent) {
  if (!current) return 'Idle';
  return CURRENT_LABELS[current.state] ?? current.state;
}

export function labelUpcomingSync(
  upcoming: ScheduleUpcoming,
  timezone?: string | null,
) {
  if (!upcoming?.at) return 'Not scheduled';
  return formatScheduleInstant(upcoming.at, timezone ?? DEFAULT_BUSINESS_TIMEZONE);
}
