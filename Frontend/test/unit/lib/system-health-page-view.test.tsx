import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const mockState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/lib/use-system-health", () => ({
  useSystemHealth: () => mockState.current,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { SystemHealthPageView } from "@/lib/system-health-page-view";

const OVERVIEW = {
  activeAutomations: 12,
  runsToday: 340,
  runsThisWeek: 900,
  succeeded: 332,
  failed: 8,
  errorRate24h: 0.023,
  trend: [0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 5],
  errorRateWindowHours: 24,
  lastTickAt: "2026-08-14T09:59:00.000Z",
  queue: {
    waiting: 3, active: 0, delayed: 0, failed: 0,
    total: 3, backlogged: false, available: true,
  },
  delivery: { bounced: 4, complained: 1, windowHours: 168 },
};

describe("SystemHealthPageView", () => {
  beforeEach(() => {
    mockState.current = {
      overview: OVERVIEW, clients: [], loading: false, error: null, refresh: vi.fn(),
    };
  });

  it("shows the headline figures", () => {
    render(<SystemHealthPageView />);

    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("340")).toBeInTheDocument();
    expect(screen.getByText("2.3%")).toBeInTheDocument();
  });

  it("reports bounces as a count, never as a not-built notice", () => {
    // Replaces an assertion that pinned the opposite. It required the screen to
    // say delivery reporting "is not built yet" — written when that was true,
    // and left asserting it after the SES event pipeline landed. The
    // expectation was the defect, not the code.
    render(<SystemHealthPageView />);
    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^Bounced \(/)).toBeInTheDocument();
  });

  it("flags a queue backlog", () => {
    mockState.current = {
      ...mockState.current,
      overview: { ...OVERVIEW, queue: { ...OVERVIEW.queue, total: 80, backlogged: true } },
    };

    render(<SystemHealthPageView />);
    expect(screen.getByText(/backlog/i)).toBeInTheDocument();
  });

  it("says so when the queue could not be read, rather than showing a false zero", () => {
    mockState.current = {
      ...mockState.current,
      overview: { ...OVERVIEW, queue: { ...OVERVIEW.queue, available: false } },
    };

    render(<SystemHealthPageView />);
    expect(screen.getByText(/queue unavailable/i)).toBeInTheDocument();
  });

  it("renders an error banner without blanking the page", () => {
    mockState.current = { ...mockState.current, error: "Could not load system health" };

    render(<SystemHealthPageView />);

    expect(screen.getByText(/could not load system health/i)).toBeInTheDocument();
    expect(screen.getByText("340")).toBeInTheDocument();
  });

  it("shows when the scheduler last ticked", () => {
    render(<SystemHealthPageView />);
    expect(screen.getByText(/last ticked/i)).toBeInTheDocument();
  });

  it("tells the operator the scheduler has never ticked, rather than showing a blank dash", () => {
    mockState.current = {
      ...mockState.current,
      overview: { ...OVERVIEW, lastTickAt: null },
    };

    render(<SystemHealthPageView />);
    expect(screen.getByText(/scheduler has never ticked/i)).toBeInTheDocument();
    expect(screen.getByText(/eventbridge/i)).toBeInTheDocument();
  });
});

/**
 * 6.4 names "bounce/complaint count" as one of the six metrics. The screen
 * shipped a hardcoded paragraph saying delivery reporting was not built —
 * written when that was true, still there after the SES pipeline landed. An
 * operator chasing a bounce was told to stop looking.
 */
describe("bounce and complaint counts", () => {
  it("shows the counts rather than a not-built notice", () => {
    render(<SystemHealthPageView />);

    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    // Anchored to the tile labels; the section heading also says "complaints".
    expect(screen.getByText(/^Bounced \(168h\)$/)).toBeInTheDocument();
    expect(screen.getByText(/^Complaints \(168h\)$/)).toBeInTheDocument();
    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument();
  });

  it("renders zero as a number, not as an absence", () => {
    mockState.current = {
      ...mockState.current,
      overview: { ...OVERVIEW, delivery: { bounced: 0, complained: 0, windowHours: 168 } },
    };

    render(<SystemHealthPageView />);

    // "0 bounced" and "we cannot tell you" must not look the same.
    expect(screen.queryByText(/not built yet/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  });
});
