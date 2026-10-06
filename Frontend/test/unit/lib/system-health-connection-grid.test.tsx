import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SystemHealthConnectionGrid } from "@/lib/system-health-connection-grid";
import type { ClientRow } from "@/lib/system-health-types";

const ROW: ClientRow = {
  workspaceId: "ws-7f3a91c2",
  name: "Acme Disability Services",
  invoiceEnabled: true,
  statementEnabled: false,
  provider: "xero",
  connection: "connected",
};

describe("SystemHealthConnectionGrid", () => {
  /**
   * KAN-43. The row was labelled with the raw workspaceId, which is opaque to
   * the Support Admin choosing a client to drill into.
   */
  it("labels the row with the client name", () => {
    render(<SystemHealthConnectionGrid clients={[ROW]} onSelect={vi.fn()} />);

    expect(screen.getByText("Acme Disability Services")).toBeInTheDocument();
  });

  /**
   * The name replaces the id as the *label*, it does not replace the id. The
   * workspaceId is what appears in logs, in the drill-down URL and in every
   * support conversation, so an operations screen that drops it makes those
   * harder to join up than they were before the fix.
   */
  it("keeps the workspace id visible alongside the name", () => {
    render(<SystemHealthConnectionGrid clients={[ROW]} onSelect={vi.fn()} />);

    expect(screen.getByText("ws-7f3a91c2")).toBeInTheDocument();
  });

  /**
   * `name` is optional on Business and absent entirely for a configured
   * workspace with no Business row, so the API sends null. The id is then the
   * only identifier there is — but it must not be rendered twice, which would
   * read as a duplicated row.
   */
  it("falls back to the workspace id alone when the client has no name", () => {
    render(
      <SystemHealthConnectionGrid clients={[{ ...ROW, name: null }]} onSelect={vi.fn()} />,
    );

    expect(screen.getAllByText("ws-7f3a91c2")).toHaveLength(1);
  });

  it("selects by workspace id, not by name, when a row is clicked", async () => {
    const onSelect = vi.fn();
    render(<SystemHealthConnectionGrid clients={[ROW]} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button"));

    expect(onSelect).toHaveBeenCalledWith("ws-7f3a91c2");
  });
});
