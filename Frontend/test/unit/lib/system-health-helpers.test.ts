import { describe, it, expect } from "vitest";

import {
  formatErrorRate,
  formatDuration,
  formatStartedAt,
  runStatusLabel,
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
  it("renders an absolute timestamp in the reader's local time", () => {
    const iso = "2026-08-13T09:00:00.000Z";
    const expected = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(iso));
    expect(formatStartedAt(iso)).toContain(expected);
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
    expect(runStatusLabel("skipped")).toBe("Pending setup");
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
