import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/app/utils/axiosConfig", () => ({ default: { get } }));

import { SYSTEM_HEALTH_POLL_MS } from "@/constants/system-health";
import { useSystemHealth } from "@/lib/use-system-health";

const OVERVIEW = { activeAutomations: 1, runsToday: 0, failed: 0, errorRate24h: 0, trend: [] };
const CLIENTS = { clients: [{ workspaceId: "ws-1", connection: "connected" }] };

describe("useSystemHealth", () => {
  beforeEach(() => {
    get.mockReset();
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://api.isoplus.test";
  });

  it("loads the overview and the client grid together", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve({ data: url.endsWith("/overview") ? OVERVIEW : CLIENTS }),
    );

    const { result } = renderHook(() => useSystemHealth());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.overview).toEqual(OVERVIEW);
    expect(result.current.clients).toEqual(CLIENTS.clients);
    expect(result.current.error).toBeNull();
  });

  // The poll interval must be cleared on unmount, or every mounted-then-
  // unmounted System Health tab leaves a timer fetching forever. Fake timers
  // rather than a real wait: the interval is 30s, so a real-time test would
  // have to sleep 30s to observe anything — and a test that waits less than
  // the interval passes whether or not the cleanup exists, which is exactly
  // the vacuous shape this replaced.
  it("stops polling once unmounted", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve({ data: url.endsWith("/overview") ? OVERVIEW : CLIENTS }),
    );

    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useSystemHealth());
      await vi.advanceTimersByTimeAsync(SYSTEM_HEALTH_POLL_MS);
      const callsWhileMounted = get.mock.calls.length;
      expect(callsWhileMounted).toBeGreaterThan(2);

      unmount();
      await vi.advanceTimersByTimeAsync(SYSTEM_HEALTH_POLL_MS * 3);

      expect(get.mock.calls.length).toBe(callsWhileMounted);
    } finally {
      vi.useRealTimers();
    }
  });

  // `cancelledRef` in use-system-health.ts has NO observable behaviour to
  // assert: React 18 silently drops a state update scheduled on an unmounted
  // fiber — no render, no warning, no throw — so a hook with the guard and one
  // without are indistinguishable from outside. It is defensive code, verified
  // by inspection, and deliberately has NO test here rather than one that would
  // pass with the guard deleted. An earlier version of this file carried such a
  // test twice over; both are gone.
});
