import { describe, it, expect } from "vitest";

import {
  formatErrorRate,
  formatDuration,
  formatStartedAt,
  runStatusLabel,
  timezoneForKind,
  sortClientsBySeverity,
} from "@/lib/system-health-helpers";

describe("formatErrorRate", () => {
  it("renders a rate as a percentage", () => {
    expect(formatErrorRate(0.333)).toBe("33.3%");
    expect(formatErrorRate(0)).toBe("0%");
    expect(formatErrorRate(1)).toBe("100%");
  });

  it("renders a missing rate as a dash, never NaN%", () => {
    expect(formatErrorRate(undefined)).toBe("—");
    expect(formatErrorRate(Number.NaN)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("renders milliseconds and seconds", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(1500)).toBe("1.5s");
  });

  it("renders an absent duration as a dash, not 0ms", () => {
    // A skipped run has no duration. "0ms" would read as an instant success.
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
  });
});

describe("formatStartedAt", () => {
  /**
   * The schedule's zone, not the reader's. A run history sits beside a Run At
   * field that is a wall-clock time in the schedule's own zone, so formatting
   * the instant locally puts two clocks on one screen: a workspace running at
   * 21:54 Sydney read "7:54 PM" to a reader in Manila, contradicting the
   * Automation tab directly. Same defect PR #880 fixed there, via formatNextRun.
   */
  it("renders a timestamp in the schedule's zone, not the reader's", () => {
    const iso = "2026-08-26T11:54:00.000Z";
    expect(formatStartedAt(iso, "Australia/Sydney")).toBe("26/08/2026 at 9:54 PM");
    expect(formatStartedAt(iso, "Asia/Manila")).toBe("26/08/2026 at 7:54 PM");
  });

  it("falls back to the business default when the zone is absent or rejected", () => {
    const iso = "2026-08-26T11:54:00.000Z";
    const expected = "26/08/2026 at 9:54 PM";
    expect(formatStartedAt(iso)).toBe(expected);
    expect(formatStartedAt(iso, "Not/AZone")).toBe(expected);
  });

  it("renders a missing timestamp as a dash, not an empty string", () => {
    expect(formatStartedAt(null)).toBe("—");
    expect(formatStartedAt(undefined)).toBe("—");
  });

  it("renders an unparseable timestamp as a dash rather than 'Invalid Date'", () => {
    expect(formatStartedAt("not-a-date")).toBe("—");
  });
});

describe("runStatusLabel", () => {
  it("names a skipped run for what it is", () => {
    expect(runStatusLabel("skipped")).toBe("Skipped");
  });

  it("passes through the ordinary states", () => {
    expect(runStatusLabel("succeeded")).toBe("Succeeded");
    expect(runStatusLabel("failed")).toBe("Failed");
    expect(runStatusLabel("queued")).toBe("Queued");
  });

  it("does not crash on an unknown status", () => {
    expect(runStatusLabel("wat" as never)).toBe("Unknown");
  });
});

describe("sortClientsBySeverity", () => {
  it("puts the clients needing attention first", () => {
    const rows = [
      { workspaceId: "a", connection: "connected" as const },
      { workspaceId: "b", connection: "disconnected" as const },
      { workspaceId: "c", connection: "needs_reauth" as const },
    ];

    expect(sortClientsBySeverity(rows).map((r) => r.workspaceId)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate its input", () => {
    const rows = [
      { workspaceId: "a", connection: "connected" as const },
      { workspaceId: "c", connection: "needs_reauth" as const },
    ];
    const copy = [...rows];

    sortClientsBySeverity(rows);

    expect(rows).toEqual(copy);
  });
});

describe("timezoneForKind", () => {
  const schedules = [
    { kind: "invoice_automation", timezone: "Australia/Sydney" },
    { kind: "statement_automation", timezone: "Australia/Perth" },
  ] as const;

  it("takes the zone from the schedule of the same kind", () => {
    expect(timezoneForKind(schedules, "invoice_automation")).toBe("Australia/Sydney");
    expect(timezoneForKind(schedules, "statement_automation")).toBe("Australia/Perth");
  });

  /**
   * A run whose schedule has since been deleted still has to render. Any
   * workspace schedule is a better guess than the reader's browser, because
   * every schedule on a workspace carries that workspace's zone.
   */
  it("falls back to another schedule's zone when the kind has none", () => {
    expect(timezoneForKind(schedules, "board_sync")).toBe("Australia/Sydney");
  });

  it("returns undefined when there are no schedules, so the formatter defaults", () => {
    expect(timezoneForKind([], "invoice_automation")).toBeUndefined();
  });
});
