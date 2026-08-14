import { describe, it, expect } from 'vitest';

import { summariseRuns } from '../../../src/utils/automationRunMetrics.js';
import {
  TREND_BUCKETS,
  RUN_SUCCEEDED,
  RUN_FAILED,
  RUN_SKIPPED,
} from '../../../src/constants/systemHealth.js';

const NOW = new Date('2026-08-13T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const run = (status, startedAt) => ({ status, startedAt });

describe('summariseRuns', () => {
  it('returns zeroes for an empty history rather than NaN', () => {
    const out = summariseRuns([], NOW);

    expect(out.runsToday).toBe(0);
    expect(out.succeeded).toBe(0);
    expect(out.failed).toBe(0);
    // 0/0 is the case that produces NaN and renders as "NaN%".
    expect(out.errorRate24h).toBe(0);
    expect(out.trend).toHaveLength(TREND_BUCKETS);
    expect(out.trend.every((n) => n === 0)).toBe(true);
  });

  it('counts today and this week separately', () => {
    const out = summariseRuns(
      [
        run(RUN_SUCCEEDED, hoursAgo(1)),
        run(RUN_SUCCEEDED, hoursAgo(5)),
        run(RUN_SUCCEEDED, hoursAgo(30)), // yesterday, still this week
        run(RUN_SUCCEEDED, hoursAgo(24 * 9)), // last week
      ],
      NOW,
    );

    expect(out.runsToday).toBe(2);
    expect(out.runsThisWeek).toBe(3);
  });

  it('splits success from failure', () => {
    const out = summariseRuns(
      [run(RUN_SUCCEEDED, hoursAgo(1)), run(RUN_FAILED, hoursAgo(2)), run(RUN_FAILED, hoursAgo(3))],
      NOW,
    );

    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(2);
  });

  it('computes the error rate over the 24h window only', () => {
    const out = summariseRuns(
      [
        run(RUN_FAILED, hoursAgo(1)),
        run(RUN_SUCCEEDED, hoursAgo(2)),
        run(RUN_SUCCEEDED, hoursAgo(3)),
        run(RUN_FAILED, hoursAgo(48)), // outside the window, must not count
      ],
      NOW,
    );

    expect(out.errorRate24h).toBe(0.333);
  });

  it('excludes skipped runs from the error rate, which is about failures', () => {
    // Every run is skipped while delivery is unbuilt. Counting those as errors
    // would show a 100% error rate on a system that is merely not finished.
    const out = summariseRuns(
      [run(RUN_SKIPPED, hoursAgo(1)), run(RUN_SKIPPED, hoursAgo(2))],
      NOW,
    );

    expect(out.errorRate24h).toBe(0);
    expect(out.failed).toBe(0);
  });

  it('buckets failures oldest-first across the window', () => {
    // 24h over 12 buckets = 2h each. A failure 1h ago lands in the last bucket.
    const out = summariseRuns([run(RUN_FAILED, hoursAgo(1))], NOW);

    expect(out.trend).toHaveLength(TREND_BUCKETS);
    expect(out.trend.at(-1)).toBe(1);
    expect(out.trend.slice(0, -1).every((n) => n === 0)).toBe(true);
  });

  it('ignores a run older than the window when bucketing', () => {
    const out = summariseRuns([run(RUN_FAILED, hoursAgo(100))], NOW);
    expect(out.trend.every((n) => n === 0)).toBe(true);
  });
});
