import { computeNextRun, computeCurrentCronSlot, isValidSchedule } from './nextRun.js';
import { runBoardSyncSweep } from './handlers.js';
import { resolveBoardSyncCron } from '../../utils/boardSyncSweepHelpers.js';
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
  if (!isValidSchedule(expression, timezone)) {
    return { cron: expression, timezone, nextRunAt: null };
  }
  return {
    cron: expression,
    timezone,
    nextRunAt: computeNextRun(expression, timezone, now),
  };
}

async function fireBoardSyncSweep({ now = new Date() } = {}) {
  const expression = resolveBoardSyncCron();
  const slot = computeCurrentCronSlot(expression, DEFAULT_TIMEZONE, now);
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
 * skipped (test env / invalid cron). Uses cron-parser + setTimeout rather than
 * a third scheduling library — computeNextRun already exists for the same expr.
 */
export function startBoardSyncCron({ env = process.env } = {}) {
  if (env.NODE_ENV === 'test') return null;

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
    const delay = Math.max(
      0,
      computeNextRun(expression, DEFAULT_TIMEZONE, new Date()) - Date.now(),
    );
    timeoutId = setTimeout(fire, delay);
    timeoutId.unref?.();
  };

  const fire = () => {
    void fireBoardSyncSweep();
    arm();
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
