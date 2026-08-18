import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/app/utils/axiosConfig", () => ({ default: { get } }));

import { useSystemHealth } from "@/lib/use-system-health";

const OVERVIEW = { activeAutomations: 1, runsToday: 0, failed: 0, errorRate24h: 0, trend: [] };
const CLIENTS = { clients: [{ workspaceId: "ws-1", connection: "connected" }] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  // Regression guard for the unmount case the hook's poll loop has to handle:
  // an in-flight request that resolves after the component using this hook
  // has gone away. Verified with a manually-controlled promise so the
  // resolution can be made to land strictly after unmount() returns. Cannot
  // assert on internal state directly (React 18 silently drops a state update
  // scheduled on an unmounted fiber — no render, no warning, verified against
  // this exact test harness before writing this test), so this asserts on the
  // externally observable contract instead: the guarded resolution must not
  // throw, must not produce an unhandled rejection, and must not trigger a
  // further axios call once cleanup has run.
  it("does not throw or poll again when an in-flight request resolves after unmount", async () => {
    const overviewDeferred = deferred<{ data: typeof OVERVIEW }>();
    get.mockImplementation((url: string) =>
      url.endsWith("/overview") ? overviewDeferred.promise : Promise.resolve({ data: CLIENTS }),
    );

    const { unmount } = renderHook(() => useSystemHealth());
    const callsBeforeUnmount = get.mock.calls.length;
    unmount();

    overviewDeferred.resolve({ data: OVERVIEW });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(get.mock.calls.length).toBe(callsBeforeUnmount);
  });
});
