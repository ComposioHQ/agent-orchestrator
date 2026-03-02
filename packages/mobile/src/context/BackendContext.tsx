import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DashboardSession, SessionsResponse } from "../types";

const STORAGE_KEY = "@ao_backend_url";
const TERMINAL_WS_OVERRIDE_KEY = "@ao_terminal_ws_url";
const DEFAULT_URL = "http://192.168.1.1:3000";

interface BackendContextValue {
  backendUrl: string;
  setBackendUrl: (url: string) => Promise<void>;
  /** WebSocket URL for the terminal server. Auto-derived unless manually overridden. */
  terminalWsUrl: string;
  /** Manual override for terminal WS URL (for ngrok / different host). Empty = auto-derive. */
  terminalWsOverride: string;
  setTerminalWsOverride: (url: string) => Promise<void>;
  fetchSessions: () => Promise<SessionsResponse>;
  fetchSession: (id: string) => Promise<DashboardSession>;
  sendMessage: (id: string, message: string) => Promise<void>;
  killSession: (id: string) => Promise<void>;
  restoreSession: (id: string) => Promise<void>;
}

const BackendContext = createContext<BackendContextValue | null>(null);

function deriveTerminalWsUrl(backendUrl: string): string {
  try {
    const url = new URL(backendUrl);
    return `ws://${url.hostname}:14801`;
  } catch {
    return "ws://192.168.1.1:14801";
  }
}

/** Convert an ngrok https URL to a wss URL for WebSocket connections */
function normalizeWsUrl(url: string): string {
  return url.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}

export function BackendProvider({ children }: { children: React.ReactNode }) {
  const [backendUrl, setBackendUrlState] = useState(DEFAULT_URL);
  const [terminalWsOverride, setTerminalWsOverrideState] = useState("");

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(TERMINAL_WS_OVERRIDE_KEY),
    ]).then(([storedBackend, storedWs]) => {
      if (storedBackend) setBackendUrlState(storedBackend);
      if (storedWs) setTerminalWsOverrideState(storedWs);
    });
  }, []);

  const setBackendUrl = useCallback(async (url: string) => {
    const trimmed = url.trim().replace(/\/$/, "");
    setBackendUrlState(trimmed);
    await AsyncStorage.setItem(STORAGE_KEY, trimmed);
  }, []);

  const setTerminalWsOverride = useCallback(async (url: string) => {
    const trimmed = url.trim().replace(/\/$/, "");
    setTerminalWsOverrideState(trimmed);
    await AsyncStorage.setItem(TERMINAL_WS_OVERRIDE_KEY, trimmed);
  }, []);

  // Use override if set, otherwise derive from backendUrl
  const terminalWsUrl = terminalWsOverride
    ? normalizeWsUrl(terminalWsOverride)
    : deriveTerminalWsUrl(backendUrl);

  const apiFetch = useCallback(
    async (path: string, options?: RequestInit) => {
      const url = `${backendUrl}${path}`;
      const res = await fetch(url, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`${res.status}: ${text}`);
      }
      return res;
    },
    [backendUrl],
  );

  const fetchSessions = useCallback(async (): Promise<SessionsResponse> => {
    const res = await apiFetch("/api/sessions");
    return res.json() as Promise<SessionsResponse>;
  }, [apiFetch]);

  const fetchSession = useCallback(async (id: string): Promise<DashboardSession> => {
    const res = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`);
    return res.json() as Promise<DashboardSession>;
  }, [apiFetch]);

  const sendMessage = useCallback(async (id: string, message: string): Promise<void> => {
    await apiFetch(`/api/sessions/${encodeURIComponent(id)}/message`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }, [apiFetch]);

  const killSession = useCallback(async (id: string): Promise<void> => {
    await apiFetch(`/api/sessions/${encodeURIComponent(id)}/kill`, { method: "POST" });
  }, [apiFetch]);

  const restoreSession = useCallback(async (id: string): Promise<void> => {
    await apiFetch(`/api/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
  }, [apiFetch]);

  return (
    <BackendContext.Provider
      value={{
        backendUrl,
        setBackendUrl,
        terminalWsUrl,
        terminalWsOverride,
        setTerminalWsOverride,
        fetchSessions,
        fetchSession,
        sendMessage,
        killSession,
        restoreSession,
      }}
    >
      {children}
    </BackendContext.Provider>
  );
}

export function useBackend(): BackendContextValue {
  const ctx = useContext(BackendContext);
  if (!ctx) throw new Error("useBackend must be used inside BackendProvider");
  return ctx;
}
