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

  it("says delivery is not enabled yet rather than showing an empty bounce count", () => {
    render(<SystemHealthPageView />);
    expect(screen.getByText(/delivery is not enabled yet/i)).toBeInTheDocument();
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
