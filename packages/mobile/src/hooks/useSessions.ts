import { useState, useEffect, useRef, useCallback } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useBackend } from "../context/BackendContext";
import type { DashboardSession, DashboardStats } from "../types";

const POLL_INTERVAL = 5_000;

interface UseSessionsResult {
  sessions: DashboardSession[];
  stats: DashboardStats | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSessions(): UseSessionsResult {
  const { fetchSessions } = useBackend();
  const [sessions, setSessions] = useState<DashboardSession[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  const doFetch = useCallback(async () => {
    try {
      const data = await fetchSessions();
      if (!isMountedRef.current) return;
      setSessions(data.sessions ?? []);
      setStats(data.stats ?? null);
      setError(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      if (isMountedRef.current) setLoading(false);
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
    isMountedRef.current = true;
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
      isMountedRef.current = false;
      stopPolling();
      sub.remove();
    };
  }, [startPolling, stopPolling]);

  const refresh = useCallback(() => {
    setLoading(true);
    doFetch();
  }, [doFetch]);

  return { sessions, stats, loading, error, refresh };
}
