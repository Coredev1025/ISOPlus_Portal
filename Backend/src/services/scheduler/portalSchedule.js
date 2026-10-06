import { computeNextRun, isValidSchedule } from './nextRun.js';
import { runBoardSyncSweep } from './handlers.js';
import {
  resolveBoardSyncCron,
  resolveBoardSyncEnabled,
} from '../../utils/boardSyncSweepHelpers.js';
import {
  BOARD_SYNC_KIND,
  DEFAULT_TIMEZONE,
  LOG_SCOPE,
} from '../../constants/scheduler.js';
import { info, warn, error } from '../../utils/logger.js';

/**
 * Cron + timezone + next fire for Board Configuration status.
 * Derived from env, not from a ScheduledJob row.
 */
export function buildPortalBoardSyncMeta({ now = new Date() } = {}) {
  const expression = resolveBoardSyncCron();
  const timezone = DEFAULT_TIMEZONE;
  if (!resolveBoardSyncEnabled() || !isValidSchedule(expression, timezone)) {
    return { cron: expression, timezone, nextRunAt: null };
  }
  return {
    cron: expression,
    timezone,
    nextRunAt: computeNextRun(expression, timezone, now),
  };
}

async function fireBoardSyncSweep({ slot }) {
  try {
    await runBoardSyncSweep({ slot, timezone: DEFAULT_TIMEZONE });
  } catch (err) {
    error(LOG_SCOPE, 'board_sync cron sweep failed', {
      kind: BOARD_SYNC_KIND,
      error: err.message,
    });
  }
}

/**
 * Starts the in-process board catch-up clock. Returns `{ stop }` or null when
 * skipped (test env / disabled / invalid cron). Uses cron-parser + setTimeout
 * rather than a third scheduling library — computeNextRun already exists for
 * the same expr.
 *
 * The slot is captured when the timer is armed and passed into the fire
 * callback. Re-deriving it from Date.now() inside the callback is unsafe:
 * setTimeout can run a millisecond early and would resolve to the previous
 * cron occurrence — a silent skipped day.
 */
export function startBoardSyncCron({ env = process.env } = {}) {
  if (env.NODE_ENV === 'test') return null;

  if (!resolveBoardSyncEnabled(env)) {
    info(LOG_SCOPE, 'board_sync cron not started: BOARD_SYNC_ENABLED is off');
    return null;
  }

  const expression = resolveBoardSyncCron(env);
  if (!isValidSchedule(expression, DEFAULT_TIMEZONE)) {
    warn(LOG_SCOPE, 'board_sync cron not started: invalid BOARD_SYNC_CRON', {
      cron: expression,
    });
    return null;
  }

  let timeoutId = null;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    const slot = computeNextRun(expression, DEFAULT_TIMEZONE, new Date());
    const delay = Math.max(0, slot.getTime() - Date.now());
    timeoutId = setTimeout(() => {
      void fireBoardSyncSweep({ slot });
      arm();
    }, delay);
    timeoutId.unref?.();
  };

  arm();

  info(LOG_SCOPE, 'board_sync cron started', {
    cron: expression,
    timezone: DEFAULT_TIMEZONE,
  });

  return {
    stop() {
      stopped = true;
      if (timeoutId != null) clearTimeout(timeoutId);
    },
  };
}
