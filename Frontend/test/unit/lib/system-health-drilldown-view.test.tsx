import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());

vi.mock("@/app/utils/axiosConfig", () => ({ default: { get, post } }));

import { SystemHealthDrilldownView } from "@/lib/system-health-drilldown-view";

const RUN = {
  _id: "r1", workspaceId: "ws-1", boardId: "b1", kind: "invoice_automation",
  periodKey: "20260116-0900", jobId: "inv:b1:20260116-0900", status: "skipped",
  skipReason: "delivery_not_implemented", trigger: "schedule",
  startedAt: "2026-08-13T00:00:00.000Z", finishedAt: null,
  durationMs: null, recipient: null, error: null,
};

describe("SystemHealthDrilldownView", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({
      data: { workspaceId: "ws-1", schedules: [], runs: [RUN], total: 1, page: 1, pageSize: 50 },
    });
  });

  it("lists the run history", async () => {
    render(<SystemHealthDrilldownView workspaceId="ws-1" />);

    expect(await screen.findByText("b1")).toBeInTheDocument();
    // A skipped run reads as "Pending setup", and has no duration.
    expect(screen.getByText("Pending setup")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
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
});
