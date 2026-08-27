import { DEFAULT_BUSINESS_TIMEZONE } from '@/constants/timezone';

export type PreviousSyncStatus = 'completed' | 'failed';

export type SchedulePrevious = {
  at: string;
  status?: PreviousSyncStatus;
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

/** States that mean a catch-up is live — compact summary says Current (In progress). */
const LIVE_CURRENT_STATES = new Set([
  'waiting',
  'delayed',
  'active',
  'in-progress',
  'started',
]);

const PREVIOUS_STATUS_LABELS: Record<PreviousSyncStatus, string> = {
  completed: 'Success',
  failed: 'Failed',
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

export function labelPreviousSync(
  previous: SchedulePrevious,
  timezone: string | null | undefined,
) {
  if (!previous?.at) return 'None yet';
  const instant = formatScheduleInstant(previous.at, timezone || undefined);
  const statusKey = previous.status === 'failed' ? 'failed' : 'completed';
  return `${instant} (${PREVIOUS_STATUS_LABELS[statusKey]})`;
}

/**
 * One-line copy for Invoice / Statement generators when auto-sync is on.
 * Returns null when there is nothing useful to show.
 */
export function formatBoardSyncScheduleSummary(
  schedule: BoardSyncSchedule | null | undefined,
): string | null {
  if (!schedule) return null;

  const timezone = schedule.timezone;
  const parts: string[] = [];

  if (schedule.previous?.at) {
    parts.push(`Previous ${labelPreviousSync(schedule.previous, timezone)}`);
  }

  if (schedule.current && LIVE_CURRENT_STATES.has(schedule.current.state)) {
    parts.push('Current (In progress)');
  } else if (schedule.upcoming?.at) {
    parts.push(
      `Next scheduled run ${formatScheduleInstant(schedule.upcoming.at, timezone || undefined)}`,
    );
  }

  if (parts.length === 0) return null;
  return `Sync schedule: ${parts.join(', ')}`;
}
