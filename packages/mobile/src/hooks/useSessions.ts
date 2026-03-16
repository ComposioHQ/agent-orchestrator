import { useState, useEffect, useRef, useCallback } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useBackend } from "../context/BackendContext";
import type { DashboardSession, DashboardStats } from "../types";

const POLL_INTERVAL = 5_000;

interface UseSessionsResult {
  sessions: DashboardSession[];
  stats: DashboardStats | null;
  orchestratorId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSessions(): UseSessionsResult {
  const { fetchSessions } = useBackend();
  const [sessions, setSessions] = useState<DashboardSession[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [orchestratorId, setOrchestratorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Generation counter — incremented on cleanup to invalidate in-flight fetches
  // from a previous effect run (e.g. when backend URL changes).
  const fetchGenRef = useRef(0);

  const doFetch = useCallback(async () => {
    const gen = fetchGenRef.current;
    try {
      const data = await fetchSessions();
      if (gen !== fetchGenRef.current) return;
      setSessions(data.sessions ?? []);
      setStats(data.stats ?? null);
      setOrchestratorId(data.orchestratorId ?? null);
      setError(null);
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      if (gen === fetchGenRef.current) setLoading(false);
    }
  }, [fetchSessions]);

  const startPolling = useCallback(() => {
    doFetch();
    intervalRef.current = setInterval(doFetch, POLL_INTERVAL);
  }, [doFetch]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    startPolling();

    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === "active") {
        // Resumed — refresh immediately and restart polling
        stopPolling();
        startPolling();
      } else {
        // Backgrounded — stop polling to save battery
        stopPolling();
      }
    };

    const sub = AppState.addEventListener("change", handleAppState);

    return () => {
      fetchGenRef.current++; // Invalidate in-flight fetches from this effect run
      stopPolling();
      sub.remove();
    };
  }, [startPolling, stopPolling]);

  const refresh = useCallback(() => {
    setLoading(true);
    doFetch();
  }, [doFetch]);

  return { sessions, stats, orchestratorId, loading, error, refresh };
}
