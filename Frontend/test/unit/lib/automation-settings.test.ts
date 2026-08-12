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

  it("puts the whole settings object", async () => {
    (axios.put as any).mockResolvedValue({
      data: { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK },
    });
    const payload = { invoice: DEFAULT_BLOCK, statement: DEFAULT_BLOCK };
    await saveAutomationSettings("ws-1", payload);
    expect(axios.put).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/ws-1/automation-settings"),
      payload,
    );
  });
});
