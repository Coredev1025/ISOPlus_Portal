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
  skipReason: "no_recipient", trigger: "schedule",
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
    // A skipped run reads as "Skipped", and has no duration.
    expect(screen.getByText("Skipped")).toBeInTheDocument();
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
  // Driven by Retry since KAN-230 removed the manual run buttons. The guard is
  // unchanged: it is about which page the reload targets, not about what
  // started it.
  it("reloads the page currently on screen, not the one showing when the retry started", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve({
        data: {
          workspaceId: "ws-1", schedules: [], total: 120, pageSize: 50,
          page: url.includes("page=2") ? 2 : 1,
          runs: [url.includes("page=2") ? { ...RUN, _id: "r9", boardId: "b9" } : FAILED_RUN],
        },
      }),
    );
    let resolvePost!: (value: unknown) => void;
    post.mockReturnValue(new Promise((r) => { resolvePost = r; }));

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");

    await userEvent.click(screen.getByRole("button", { name: /^retry$/i }));
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

  // Retry is the only dispatch this screen can start since KAN-230, so the
  // gate now guards one direction: a second retry fired while the first is
  // still in flight would race it for the same run.
  it("disables Retry while a retry is in flight", async () => {
    respondWith({ runs: [FAILED_RUN], total: 1 });
    post.mockReturnValue(new Promise(() => {}));

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");
    await userEvent.click(screen.getByRole("button", { name: /^retry$/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /^retry$/i })).toBeDisabled());
  });

  it("shows an error when the initial load fails, rather than looking empty", async () => {
    get.mockReset();
    get.mockRejectedValue(new Error("network down"));

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
  });

  it("shows explicit copy when a workspace genuinely has no runs", async () => {
    respondWith({ runs: [], total: 0 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
  });
});

/**
 * `skipReason` is computed by the worker, stored, returned by the route and
 * declared on the client type — and rendered nowhere. A skipped run showed the
 * bare word "Skipped", so an operator could not tell a disabled block from a
 * missing Xero connection from a participant with no address. Telling them
 * apart is the whole reason the drill-down exists.
 */
/**
 * KAN-230. The two manual trigger buttons are gone by product decision.
 *
 * The drill-down is a place to read what the scheduler did, not a place to
 * make it do something. What went with them is the whole dispatch path: the
 * 409 refusal card and its "Force re-run" override existed only to resolve a
 * manual run, and nothing can reach them once nothing starts one.
 *
 * Retry is deliberately untouched. It re-runs one named historical run rather
 * than starting a period, which is a different control the ticket does not
 * name.
 */
describe("the drill-down does not trigger runs", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    respondWith({ runs: [RUN], total: 1 });
  });

  it("offers neither manual run button", async () => {
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");

    expect(screen.queryByRole("button", { name: /run invoices now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run statements now/i })).not.toBeInTheDocument();
  });

  // The override only ever appeared in answer to a refused manual run, so it
  // cannot be reachable once the buttons that started one are gone.
  it("offers no force re-run override", async () => {
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");

    expect(screen.queryByRole("button", { name: /force re-run/i })).not.toBeInTheDocument();
  });

  // The assertion that outlives any wording change: rendering the page must
  // not POST to the dispatch endpoint at all.
  it("never posts to the run endpoint on render", async () => {
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");

    const runPosts = post.mock.calls.filter(([url]) => /\/run(\?|$)/.test(String(url)));
    expect(runPosts).toEqual([]);
  });

  // Retry is a different control and stays. Guarding it here means a future
  // tidy-up that deletes the rest of the dispatch plumbing cannot quietly
  // take retry with it.
  it("still offers retry on a failed run", async () => {
    respondWith({ runs: [FAILED_RUN], total: 1 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");

    expect(await screen.findByRole("button", { name: /^retry$/i })).toBeInTheDocument();
  });
});

/**
 * KAN-267. A run with nothing to bill closes Succeeded and sends nothing —
 * correctly. The panel said only "No emails were sent for this run", which
 * reads identically to a misconfiguration, and the info log that explained it
 * was unreachable in the Application Logs viewer. The run now carries the
 * reason, and the panel states it.
 */
describe("a successful run that sent nothing says why", () => {
  const QUIET_RUN = {
    ...RUN,
    _id: "r-quiet",
    status: "succeeded",
    skipReason: null,
    outcomeReason: "no_documents_generated",
  };

  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    respondWith({ runs: [QUIET_RUN], total: 1 });
  });

  // These tests expand a run, so they DO fetch /emails. "is not fetched until
  // the operator asks for it" below asserts on the whole call history, so the
  // history has to be handed back clean or this block fails that one.
  afterEach(() => {
    get.mockClear();
    post.mockClear();
  });

  it("explains an empty period instead of only saying nothing was sent", async () => {
    get.mockResolvedValueOnce({
      data: { workspaceId: "ws-1", schedules: [], runs: [QUIET_RUN], total: 1, page: 1, pageSize: 50 },
    });
    get.mockResolvedValue({ data: { emails: [] } });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");
    await userEvent.click(screen.getByRole("button", { name: /show emails/i }));

    expect(
      await screen.findByText(/nothing to bill in this period/i),
    ).toBeInTheDocument();
  });

  // The bare sentence on its own was the complaint; it must not be the whole
  // answer any more.
  it("does not leave the bare 'no emails' line as the only explanation", async () => {
    get.mockResolvedValueOnce({
      data: { workspaceId: "ws-1", schedules: [], runs: [QUIET_RUN], total: 1, page: 1, pageSize: 50 },
    });
    get.mockResolvedValue({ data: { emails: [] } });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");
    await userEvent.click(screen.getByRole("button", { name: /show emails/i }));

    await screen.findByText(/nothing to bill in this period/i);
    const bare = screen.queryByText("No emails were sent for this run.");
    expect(bare).toBeNull();
  });

  // A run whose documents went to the accounting platform is a different
  // answer, and must not be described as an empty period.
  it("distinguishes documents that were not emailed from an empty period", async () => {
    const pushed = { ...QUIET_RUN, _id: "r-pushed", outcomeReason: "documents_generated_but_not_emailed" };
    get.mockResolvedValueOnce({
      data: { workspaceId: "ws-1", schedules: [], runs: [pushed], total: 1, page: 1, pageSize: 50 },
    });
    get.mockResolvedValue({ data: { emails: [] } });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");
    await userEvent.click(screen.getByRole("button", { name: /show emails/i }));

    expect(await screen.findByText(/were not emailed/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing to bill in this period/i)).toBeNull();
  });

  // A run that genuinely sent nothing and carries no reason must still say
  // something rather than rendering an empty space.
  it("falls back to the plain sentence when the run carries no reason", async () => {
    const noReason = { ...QUIET_RUN, _id: "r-none", outcomeReason: null };
    get.mockResolvedValueOnce({
      data: { workspaceId: "ws-1", schedules: [], runs: [noReason], total: 1, page: 1, pageSize: 50 },
    });
    get.mockResolvedValue({ data: { emails: [] } });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText("b1");
    await userEvent.click(screen.getByRole("button", { name: /show emails/i }));

    expect(await screen.findByText(/no emails were sent for this run/i)).toBeInTheDocument();
  });
});

describe("skipped runs say why", () => {
  it("names the reason a run was skipped", async () => {
    respondWith({ runs: [{ ...RUN, skipReason: "accounting_not_connected" }], total: 1 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText(/accounting platform is not connected/i)).toBeInTheDocument();
  });

  it("reads no_recipient as a missing address, not as a system fault", async () => {
    respondWith({ runs: [{ ...RUN, skipReason: "no_recipient" }], total: 1 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText(/no email address/i)).toBeInTheDocument();
  });

  it("says nothing extra when a skip carries no reason", async () => {
    respondWith({ runs: [{ ...RUN, skipReason: null }], total: 1 });

    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText("Skipped")).toBeInTheDocument();
  });
});

/**
 * 6.5 asks the drill-down for "every email sent". The run row carried one
 * `recipient` string that is a participant key, not an address, and null for
 * the billing-contact route — so an operator could see a run happened and never
 * which messages it produced or what became of them.
 */
describe("per-run email detail", () => {
  const EMAILS = {
    emails: [
      {
        messageId: "m-1", recipient: "Mike Bird", recipientType: "billing_contact",
        sentAt: "2026-08-13T00:01:00.000Z", state: "delivered", detail: null,
      },
      {
        messageId: "m-2", recipient: "Jane Smith", recipientType: "client_participant",
        sentAt: "2026-08-13T00:02:00.000Z", state: "bounced",
        detail: "Email address doesn't exist.",
      },
    ],
  };

  it("is not fetched until the operator asks for it", async () => {
    respondWith({ runs: [RUN], total: 1 });
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText(RUN.boardId);

    // 50 runs times their messages would make the history page pay for detail
    // wanted one row at a time.
    expect(get.mock.calls.some(([url]) => String(url).includes("/emails"))).toBe(false);
  });

  it("lists each message with its recipient once expanded", async () => {
    const user = userEvent.setup();
    respondWith({ runs: [RUN], total: 1 });
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText(RUN.boardId);

    get.mockResolvedValueOnce({ data: EMAILS });
    await user.click(screen.getByRole("button", { name: /emails/i }));

    expect(await screen.findByText("Mike Bird")).toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
  });

  it("shows a bounce reason against the message that bounced", async () => {
    const user = userEvent.setup();
    respondWith({ runs: [RUN], total: 1 });
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText(RUN.boardId);

    get.mockResolvedValueOnce({ data: EMAILS });
    await user.click(screen.getByRole("button", { name: /emails/i }));

    expect(await screen.findByText(/doesn't exist/i)).toBeInTheDocument();
  });

  it("says so plainly when a run sent nothing", async () => {
    const user = userEvent.setup();
    respondWith({ runs: [RUN], total: 1 });
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);
    await screen.findByText(RUN.boardId);

    get.mockResolvedValueOnce({ data: { emails: [] } });
    await user.click(screen.getByRole("button", { name: /emails/i }));

    // A skipped run, or one whose documents went to Xero instead. Empty is an
    // answer, not a loading state.
    expect(await screen.findByText(/no emails/i)).toBeInTheDocument();
  });
});
