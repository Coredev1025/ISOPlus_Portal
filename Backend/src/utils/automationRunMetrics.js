import {
  RUN_SUCCEEDED,
  RUN_FAILED,
  ERROR_RATE_WINDOW_HOURS,
  TREND_BUCKETS,
} from '../constants/systemHealth.js';

const HOUR_MS = 60 * 60 * 1000;

/** Rows started at or after `from`. */
function since(rows, from) {
  return rows.filter((row) => new Date(row.startedAt).getTime() >= from);
}

/**
 * Failures per bucket across the error-rate window, oldest first.
 *
 * Bucketed by elapsed time rather than by clock hour, so the last bucket
 * always ends at `now` and the sparkline's right edge is the present.
 */
function failureTrend(windowRows, now, windowMs) {
  const buckets = new Array(TREND_BUCKETS).fill(0);
  const bucketMs = windowMs / TREND_BUCKETS;

  for (const row of windowRows) {
    if (row.status !== RUN_FAILED) continue;
    const age = now - new Date(row.startedAt).getTime();
    // Clamp: a row exactly at the window edge would otherwise index -1.
    const index = Math.min(TREND_BUCKETS - 1, Math.max(0, TREND_BUCKETS - 1 - Math.floor(age / bucketMs)));
    buckets[index] += 1;
  }

  return buckets;
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

  const todayRows = since(rows, nowMs - 24 * HOUR_MS);
  const weekRows = since(rows, nowMs - 7 * 24 * HOUR_MS);
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
    trend: failureTrend(windowRows, nowMs, windowMs),
  };
}
