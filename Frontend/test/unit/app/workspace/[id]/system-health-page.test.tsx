import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const replace = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "55369" }),
  useRouter: () => ({ replace, push: vi.fn(), back: vi.fn() }),
}));

// The drill-down does its own fetching; this page's job is the frame around it.
vi.mock("@/lib/system-health-drilldown-view", () => ({
  SystemHealthDrilldownView: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="drilldown">{workspaceId}</div>
  ),
}));

import WorkspaceSystemHealthPage from "@/app/workspace/[id]/system-health/page";

/**
 * KAN-267. Opening System Health directly dropped a reader into the run list
 * with no way out but the browser's back button — no back link, no
 * breadcrumb. Every sibling workspace page (finance settings, usage report,
 * pdf output) offers "Back to Workspace"; this one did not.
 */
describe("the System Health page frame", () => {
  beforeEach(() => replace.mockReset());

  it("still renders the run history for the workspace in the URL", () => {
    render(<WorkspaceSystemHealthPage />);
    expect(screen.getByTestId("drilldown")).toHaveTextContent("55369");
  });

  it("offers a way back to the workspace", () => {
    render(<WorkspaceSystemHealthPage />);
    expect(screen.getByRole("button", { name: /back to workspace/i })).toBeInTheDocument();
  });

  it("goes to that workspace, not a hardcoded one", async () => {
    render(<WorkspaceSystemHealthPage />);

    await userEvent.click(screen.getByRole("button", { name: /back to workspace/i }));

    expect(replace).toHaveBeenCalledWith("/workspace/55369");
  });
});
