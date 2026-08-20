import { schedule as cronSchedule, validate as cronValidate } from 'node-cron';
import ScheduledJob from '../../models/ScheduledJob.js';
import { computeNextRun, computeCurrentCronSlot, isValidSchedule } from './nextRun.js';
import { runBoardSyncSweep } from './handlers.js';
import { resolveBoardSyncCron } from '../../utils/boardSyncSweepHelpers.js';
import {
  BOARD_SYNC_KIND,
  BOARD_SYNC_TARGET_ID,
  DEFAULT_TIMEZONE,
  LOG_SCOPE,
} from '../../constants/scheduler.js';
import { info, warn, error } from '../../utils/logger.js';

const DISABLE_LEFTOVER_ATTEMPTS = 3;

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

/**
 * Rows from the EventBridge-era portal schedule must not stay enabled —
 * otherwise a tick would claim them with no registered handler.
 * Retries briefly; throws if every attempt fails so boot surfaces the miss.
 */
export async function disableLeftoverPortalBoardSyncSchedule({
  attempts = DISABLE_LEFTOVER_ATTEMPTS,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await ScheduledJob.updateMany(
        { kind: BOARD_SYNC_KIND, targetId: BOARD_SYNC_TARGET_ID, enabled: true },
        { $set: { enabled: false } },
      );
    } catch (err) {
      lastError = err;
      warn(LOG_SCOPE, 'disable leftover portal board_sync failed', {
        attempt,
        attempts,
        error: err.message,
      });
    }
  }
  throw lastError;
}

async function fireBoardSyncSweep({ now = new Date() } = {}) {
  const expression = resolveBoardSyncCron();
  const scheduledFor = computeCurrentCronSlot(expression, DEFAULT_TIMEZONE, now);
  try {
    await runBoardSyncSweep({
      targetId: BOARD_SYNC_TARGET_ID,
      workspaceId: null,
      scheduledFor,
      timezone: DEFAULT_TIMEZONE,
    });
  } catch (err) {
    error(LOG_SCOPE, 'board_sync cron sweep failed', {
      kind: BOARD_SYNC_KIND,
      error: err.message,
    });
  }
}

/**
 * Starts the in-process board catch-up clock. Returns the task (with `.stop`)
 * or null when skipped (test env / invalid cron).
 */
export function startBoardSyncCron({ env = process.env } = {}) {
  if (env.NODE_ENV === 'test') return null;

  const expression = resolveBoardSyncCron(env);
  if (!cronValidate(expression) || !isValidSchedule(expression, DEFAULT_TIMEZONE)) {
    warn(LOG_SCOPE, 'board_sync cron not started: invalid BOARD_SYNC_CRON', {
      cron: expression,
    });
    return null;
  }

  const task = cronSchedule(expression, () => {
    void fireBoardSyncSweep();
  }, { timezone: DEFAULT_TIMEZONE });

  info(LOG_SCOPE, 'board_sync cron started', {
    cron: expression,
    timezone: DEFAULT_TIMEZONE,
  });
  return task;
}
