"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import axios from "@/app/utils/axiosConfig";
import { SYSTEM_HEALTH_POLL_MS } from "@/constants/system-health";
import type { ClientRow, Overview } from "@/lib/system-health-types";

type State = {
  overview: Overview | null;
  clients: ClientRow[];
  loading: boolean;
  error: string | null;
};

/**
 * Polls the two admin endpoints together, so the tiles and the grid always
 * describe the same moment.
 */
export function useSystemHealth() {
  const [state, setState] = useState<State>({
    overview: null,
    clients: [],
    loading: true,
    error: null,
  });

  // Guards against setting state from a request that was already in flight
  // when this hook's owner unmounted — the poll runs every 30s, so navigating
  // away mid-poll is routine, not an edge case. Cleared on unmount, matching
  // the pattern in automation-status-panel.tsx. A ref, not an effect-local
  // variable, because `load` is invoked repeatedly by the interval rather
  // than once per effect run.
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [overview, clients] = await Promise.all([
        axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/overview`),
        axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/system-health/clients`),
      ]);
      if (cancelledRef.current) return;
      setState({
        overview: overview.data,
        clients: clients.data.clients ?? [],
        loading: false,
        error: null,
      });
    } catch {
      if (cancelledRef.current) return;
      // Keep whatever is on screen: a failed poll should not blank a screen
      // someone is reading.
      setState((prev) => ({ ...prev, loading: false, error: "Could not load system health" }));
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    load();
    const timer = setInterval(load, SYSTEM_HEALTH_POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
    };
  }, [load]);

  return { ...state, refresh: load };
}
