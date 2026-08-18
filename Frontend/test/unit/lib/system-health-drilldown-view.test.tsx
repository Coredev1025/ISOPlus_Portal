import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());

vi.mock("@/app/utils/axiosConfig", () => ({ default: { get, post } }));

import { SystemHealthDrilldownView } from "@/lib/system-health-drilldown-view";
import { formatStartedAt } from "@/lib/system-health-helpers";

const RUN = {
  _id: "r1", workspaceId: "ws-1", boardId: "b1", kind: "invoice_automation",
  periodKey: "20260116-0900", jobId: "inv:b1:20260116-0900", status: "skipped",
  skipReason: "delivery_not_implemented", trigger: "schedule",
  startedAt: "2026-08-13T00:00:00.000Z", finishedAt: null,
  durationMs: null, recipient: null, error: null,
};

const FAILED_RUN = {
  ...RUN,
  _id: "r2",
  jobId: "inv:b1:20260201-0900",
  status: "failed",
  trigger: "manual",
  error: "Xero token expired",
};

const SCHEDULE = {
  kind: "invoice_automation",
  enabled: true,
  nextRunAt: "2026-09-01T09:00:00.000Z",
  lastRunAt: "2026-08-01T09:00:00.000Z",
  lastError: "Xero token expired",
  missedRuns: 2,
  consecutiveFailures: 3,
  timezone: "Australia/Sydney",
};

function respondWith(data: Partial<{
  schedules: unknown[];
  runs: unknown[];
  total: number;
  page: number;
  pageSize: number;
}>) {
  get.mockResolvedValue({
    data: { workspaceId: "ws-1", schedules: [], runs: [], total: 0, page: 1, pageSize: 50, ...data },
  });
}

describe("SystemHealthDrilldownView", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    respondWith({ runs: [RUN], total: 1 });
  });

  it("lists the run history", async () => {
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText("b1")).toBeInTheDocument();
    // A skipped run reads as "Pending setup", and has no duration.
    expect(screen.getByText("Pending setup")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("requests the first page on initial load", async () => {
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");
    expect(get).toHaveBeenCalledWith(expect.stringContaining("workspace/ws-1?page=1"));
  });

  it("renders started-at, period, kind and trigger for each row — not just boardId, status, duration and recipient", async () => {
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    await screen.findByText("b1");
    expect(screen.getByText("20260116-0900")).toBeInTheDocument();
    expect(screen.getByText("invoice_automation")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText(formatStartedAt(RUN.startedAt))).toBeInTheDocument();
  });

  it("shows the failure reason and a retry control on a failed run", async () => {
    respondWith({ runs: [FAILED_RUN], total: 1 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText("Xero token expired")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeInTheDocument();
  });

  it("does not offer retry on a run that has not failed", async () => {
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    await screen.findByText("b1");
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeInTheDocument();
  });

  it("retries a failed run and reloads the history on success", async () => {
    respondWith({ runs: [FAILED_RUN], total: 1 });
    post.mockResolvedValue({ data: { retried: "r2" } });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /^retry$/i }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/workspace/ws-1/runs/r2/retry`,
      );
    });
    // The retry reloads history rather than leaving the failed row on screen
    // with no visible effect from the click.
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("explains a retry failure instead of appearing to do nothing", async () => {
    respondWith({ runs: [FAILED_RUN], total: 1 });
    post.mockRejectedValue(new Error("boom"));

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /^retry$/i }));

    expect(await screen.findByText(/could not retry the run/i)).toBeInTheDocument();
  });

  it("shows pager controls and requests the next page", async () => {
    respondWith({ runs: [RUN], total: 120, page: 1 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");

    expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(get).toHaveBeenLastCalledWith(expect.stringContaining("page=2"));
    });
  });

  it("disables Next on the last page", async () => {
    respondWith({ runs: [RUN], total: 3, page: 1, pageSize: 50 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");

    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  // The three writers to `runs` (page change, post-run reload, post-retry
  // reload) are unsequenced unless the reload always targets the page the
  // reader is actually on. A reload built from the page that was showing when
  // the button was clicked repaints page 1's rows under a "Page 2" label —
  // silently, on the one screen whose whole value is that the rows are what
  // they say they are.
  it("reloads the page currently on screen, not the one showing when the run started", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve({
        data: {
          workspaceId: "ws-1", schedules: [], total: 120, pageSize: 50,
          page: url.includes("page=2") ? 2 : 1,
          runs: [url.includes("page=2") ? { ...RUN, _id: "r9", boardId: "b9" } : RUN],
        },
      }),
    );
    let resolvePost!: (value: unknown) => void;
    post.mockReturnValue(new Promise((r) => { resolvePost = r; }));

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");

    await userEvent.click(screen.getByRole("button", { name: /run invoices now/i }));
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await screen.findByText("b9");

    resolvePost({ data: { enqueued: 1 } });

    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.stringContaining("page=2")));
    expect(screen.getByText("b9")).toBeInTheDocument();
    expect(screen.queryByText("b1")).not.toBeInTheDocument();
  });

  // An empty page must not strand the reader: gating the pager on the rows
  // returned rather than the total means the page that comes back empty also
  // hides the Previous button that is the only way back.
  it("keeps the pager on an empty page so the reader can navigate back", async () => {
    // Page 2 comes back empty — runs were deleted, or the total moved between
    // the two requests. The reader must still be able to get back to page 1.
    get.mockImplementation((url: string) =>
      Promise.resolve({
        data: {
          workspaceId: "ws-1", schedules: [], total: 120, pageSize: 50, page: 1,
          runs: url.includes("page=2") ? [] : [RUN],
        },
      }),
    );

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");
    await userEvent.click(screen.getByRole("button", { name: /next/i }));

    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous/i })).toBeEnabled();
  });

  it("renders the schedule summary above the run history", async () => {
    respondWith({ schedules: [SCHEDULE], runs: [RUN], total: 1 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText(/missed runs: 2/i)).toBeInTheDocument();
    expect(screen.getByText(/consecutive failures: 3/i)).toBeInTheDocument();
    expect(screen.getByText("Xero token expired")).toBeInTheDocument();
  });

  it("explains a refused run instead of appearing to do nothing", async () => {
    post.mockRejectedValue({
      response: { status: 409, data: { error: "already_run", periodKey: "20260116-0900", runs: [RUN] } },
    });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /run invoices now/i }));

    expect(await screen.findByText(/already run/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /force re-run/i })).toBeInTheDocument();
  });

  it("forces a re-run only after the override is chosen", async () => {
    post.mockRejectedValueOnce({
      response: { status: 409, data: { error: "already_run", periodKey: "p", runs: [RUN] } },
    });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /run invoices now/i }));

    post.mockResolvedValueOnce({ data: { enqueued: 1 } });
    await userEvent.click(screen.getByRole("button", { name: /force re-run/i }));

    await waitFor(() => {
      expect(post).toHaveBeenLastCalledWith(
        expect.stringContaining("force=1"),
        expect.anything(),
      );
    });
  });

  // Guards the behaviour the 409 duplicate-guard design depends on: a
  // regression that always appended force=1 would make the 409 branch dead
  // code while still passing every other test in this file.
  it("does not send force=1 on the first run request", async () => {
    post.mockRejectedValueOnce({
      response: { status: 409, data: { error: "already_run", periodKey: "p", runs: [RUN] } },
    });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /run invoices now/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).not.toContain("force=1");
  });

  it("shows an error when the initial load fails, rather than looking empty", async () => {
    get.mockReset();
    get.mockRejectedValue(new Error("network down"));

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });

  it("surfaces a non-409 run failure instead of silently doing nothing", async () => {
    post.mockRejectedValue(new Error("boom"));

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /run invoices now/i }));

    expect(await screen.findByText(/could not start the run/i)).toBeInTheDocument();
  });

  it("shows explicit copy when a workspace genuinely has no runs", async () => {
    respondWith({ runs: [], total: 0 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
  });
});
