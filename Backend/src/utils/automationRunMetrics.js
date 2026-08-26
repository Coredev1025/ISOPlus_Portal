import {
  RUN_SUCCEEDED,
  RUN_FAILED,
  ERROR_RATE_WINDOW_HOURS,
  TODAY_WINDOW_HOURS,
  WEEK_WINDOW_HOURS,
} from '../constants/systemHealth.js';

const HOUR_MS = 60 * 60 * 1000;

/** Rows started at or after `from`. */
function since(rows, from) {
  return rows.filter((row) => new Date(row.startedAt).getTime() >= from);
}

/**
 * Headline figures for the System Health overview.
 *
 * Pure — the caller does the query and passes the rows in, which is what makes
 * every branch here testable without a database.
 *
 * The error rate counts failed against succeeded+failed, deliberately
 * excluding skipped. While delivery is unbuilt every run is skipped, and
 * counting those as errors would report a 100% error rate for a system that is
 * simply not finished yet.
 */
export function summariseRuns(rows, now = new Date()) {
  const nowMs = now.getTime();
  const windowMs = ERROR_RATE_WINDOW_HOURS * HOUR_MS;

  const todayRows = since(rows, nowMs - TODAY_WINDOW_HOURS * HOUR_MS);
  const weekRows = since(rows, nowMs - WEEK_WINDOW_HOURS * HOUR_MS);
  const windowRows = since(rows, nowMs - windowMs);

  const succeeded = windowRows.filter((r) => r.status === RUN_SUCCEEDED).length;
  const failed = windowRows.filter((r) => r.status === RUN_FAILED).length;
  const decided = succeeded + failed;

  return {
    runsToday: todayRows.length,
    runsThisWeek: weekRows.length,
    succeeded,
    failed,
    // Guarded: 0/0 is NaN, which renders as "NaN%" on the tile.
    errorRate24h: decided === 0 ? 0 : Math.round((failed / decided) * 1000) / 1000,
  };
}
