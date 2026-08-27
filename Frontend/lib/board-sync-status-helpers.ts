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

export type SyncScheduleSummaryPart = {
  text: string;
  bold?: boolean;
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

const SUMMARY_PREVIOUS_STATUS_LABELS: Record<PreviousSyncStatus, string> = {
  completed: 'successful',
  failed: 'failed',
};

export function formatScheduleInstant(
  iso: string,
  timezone: string = DEFAULT_BUSINESS_TIMEZONE,
) {
  const formatted = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  }).format(new Date(iso));

  return formatted.replace(/\b(am|pm)\b/gi, (match) => match.toUpperCase());
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

function pushText(
  parts: SyncScheduleSummaryPart[],
  text: string,
  bold = false,
) {
  if (!text) return;
  parts.push(bold ? { text, bold: true } : { text });
}

/**
 * Structured compact sync line for Invoice / Statement generators.
 * Bold the label and each instant; keep surrounding copy normal weight.
 */
export function boardSyncScheduleSummaryParts(
  schedule: BoardSyncSchedule | null | undefined,
): SyncScheduleSummaryPart[] | null {
  if (!schedule) return null;

  const timezone = schedule.timezone;
  const parts: SyncScheduleSummaryPart[] = [];
  let hasContent = false;

  pushText(parts, 'Sync schedule:', true);

  if (schedule.previous?.at) {
    hasContent = true;
    const statusKey = schedule.previous.status === 'failed' ? 'failed' : 'completed';
    pushText(parts, ' Previous run: ');
    pushText(
      parts,
      formatScheduleInstant(schedule.previous.at, timezone || undefined),
      true,
    );
    pushText(parts, ` (${SUMMARY_PREVIOUS_STATUS_LABELS[statusKey]}).`);
  }

  if (schedule.current && LIVE_CURRENT_STATES.has(schedule.current.state)) {
    hasContent = true;
    pushText(parts, ' Current (In progress).');
  } else if (schedule.upcoming?.at) {
    hasContent = true;
    pushText(parts, ' Next scheduled run: ');
    pushText(
      parts,
      formatScheduleInstant(schedule.upcoming.at, timezone || undefined),
      true,
    );
    pushText(parts, '.');
  }

  if (!hasContent) return null;
  return parts;
}

/**
 * One-line copy for Invoice / Statement generators when auto-sync is on.
 * Returns null when there is nothing useful to show.
 */
export function formatBoardSyncScheduleSummary(
  schedule: BoardSyncSchedule | null | undefined,
): string | null {
  const parts = boardSyncScheduleSummaryParts(schedule);
  return parts ? parts.map((part) => part.text).join('') : null;
}
