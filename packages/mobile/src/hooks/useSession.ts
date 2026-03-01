import { useState, useEffect, useRef, useCallback } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useBackend } from "../context/BackendContext";
import type { DashboardSession } from "../types";

const POLL_INTERVAL = 5_000;

interface UseSessionResult {
  session: DashboardSession | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useSession(id: string): UseSessionResult {
  const { fetchSession } = useBackend();
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  const doFetch = useCallback(async () => {
    try {
      const data = await fetchSession(id);
      if (!isMountedRef.current) return;
      setSession(data);
      setError(null);
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load session");
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }, [fetchSession, id]);

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
        stopPolling();
        startPolling();
      } else {
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

  return { session, loading, error, refresh };
}
