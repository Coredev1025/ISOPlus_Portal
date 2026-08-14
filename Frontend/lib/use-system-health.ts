"use client";

import { useCallback, useEffect, useState } from "react";

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

  const load = useCallback(async () => {
    try {
      const [overview, clients] = await Promise.all([
        axios.get("/api/system-health/overview"),
        axios.get("/api/system-health/clients"),
      ]);
      setState({
        overview: overview.data,
        clients: clients.data.clients ?? [],
        loading: false,
        error: null,
      });
    } catch {
      // Keep whatever is on screen: a failed poll should not blank a screen
      // someone is reading.
      setState((prev) => ({ ...prev, loading: false, error: "Could not load system health" }));
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, SYSTEM_HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return { ...state, refresh: load };
}
