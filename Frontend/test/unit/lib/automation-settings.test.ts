import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "@/app/utils/axiosConfig";
import {
  fetchAutomationSettings,
  saveAutomationSettings,
  DEFAULT_BLOCK,
} from "@/lib/automation-settings";

vi.mock("@/app/utils/axiosConfig", () => ({
  default: { get: vi.fn(), put: vi.fn() },
}));

describe("automation-settings client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches from the workspace-scoped path", async () => {
    (axios.get as any).mockResolvedValue({
      data: { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK },
    });
    const result = await fetchAutomationSettings("ws-1");
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/ws-1/automation-settings"),
    );
    expect(result.invoice.enabled).toBe(false);
  });

  it("puts both blocks to the workspace-scoped path", async () => {
    (axios.put as any).mockResolvedValue({
      data: { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK },
    });
    const payload = { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK };
    await saveAutomationSettings("ws-1", payload);
    expect(axios.put).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/ws-1/automation-settings"),
      expect.objectContaining({
        invoice: expect.objectContaining({ enabled: false }),
        statement: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it("strips the read-only fields the server owns", async () => {
    // nextRun/lastRunAt/lastRunError are computed from ScheduledJob and
    // recentDocuments from PDFLink; sending them back invites a future schema
    // to accept what the scheduler alone should write.
    (axios.put as any).mockResolvedValue({
      data: { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK },
    });

    await saveAutomationSettings("ws-1", {
      invoice: {
        ...structuredClone(DEFAULT_BLOCK),
        nextRun: "2026-09-01T12:00:00.000Z",
        lastRunAt: "2026-08-01T12:00:00.000Z",
        lastRunError: "boom",
      },
      statement: structuredClone(DEFAULT_BLOCK),
      recentDocuments: [
        {
          type: "NDIS Invoice",
          invoiceNumber: "INV-1",
          periodKey: "20250201-0900",
          pdfUrl: "https://files.test/inv-1.pdf",
          createdAt: "2026-08-01T12:00:00.000Z",
        },
      ],
    });

    const [, body] = (axios.put as any).mock.calls[0];
    expect(body).not.toHaveProperty("recentDocuments");
    expect(body.invoice).not.toHaveProperty("nextRun");
    expect(body.invoice).not.toHaveProperty("lastRunAt");
    expect(body.invoice).not.toHaveProperty("lastRunError");
    // The editable fields still go.
    expect(body.invoice).toHaveProperty("runAt", DEFAULT_BLOCK.runAt);
    expect(body.statement).toHaveProperty("every");
  });

  it("does not mutate the settings it was given", async () => {
    (axios.put as any).mockResolvedValue({
      data: { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK },
    });
    const payload = {
      invoice: { ...structuredClone(DEFAULT_BLOCK), nextRun: "2026-09-01T12:00:00.000Z" },
      statement: structuredClone(DEFAULT_BLOCK),
    };

    await saveAutomationSettings("ws-1", payload);

    expect(payload.invoice.nextRun).toBe("2026-09-01T12:00:00.000Z");
  });

  it("freezes the outer DEFAULT_BLOCK to prevent mutation", () => {
    expect(() => {
      (DEFAULT_BLOCK as any).enabled = true;
    }).toThrow();
  });

  it("freezes the nested every object to prevent mutation", () => {
    expect(() => {
      (DEFAULT_BLOCK.every as any).unit = "day";
    }).toThrow();
  });
});
