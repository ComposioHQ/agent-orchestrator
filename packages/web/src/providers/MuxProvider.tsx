"use client";

import React, { useEffect, useRef, useState, useMemo, useCallback, type ReactNode } from "react";
import type { ClientMessage, ServerMessage, SessionPatch } from "@/lib/mux-protocol";

interface MuxContextValue {
  subscribeTerminal: (id: string, callback: (data: string) => void) => () => void;
  writeTerminal: (id: string, data: string) => void;
  openTerminal: (id: string) => void;
  closeTerminal: (id: string) => void;
  resizeTerminal: (id: string, cols: number, rows: number) => void;
  status: "connecting" | "connected" | "reconnecting" | "disconnected";
  sessions: SessionPatch[];
}

const MuxContext = React.createContext<MuxContextValue | undefined>(undefined);

export function useMux(): MuxContextValue {
  const context = React.useContext(MuxContext);
  if (!context) {
    throw new Error("useMux() must be used within <MuxProvider>");
  }
  return context;
}

/** Like useMux() but returns undefined when outside a MuxProvider (safe for tests). */
export function useMuxOptional(): MuxContextValue | undefined {
  return React.useContext(MuxContext);
}

interface RuntimeTerminalConfig {
  directTerminalPort?: unknown;
  proxyWsPath?: unknown;
}

interface TerminalGrantResponse {
  token?: unknown;
  expiresAt?: unknown;
}

interface TerminalGrantCacheEntry {
  token: string;
  expiresAtMs: number;
}

const TERMINAL_GRANT_SKEW_MS = 5_000;

function normalizePortValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return undefined;
  return String(parsed);
}

function normalizePathValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return undefined;
  return trimmed;
}

function buildMuxWsUrl(runtimeConfig: { directTerminalPort?: string; proxyWsPath?: string }): string {
  const loc = window.location;
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";

  // Runtime proxy path takes priority (set by `ao start` via TERMINAL_WS_PATH env var)
  const proxyWsPath = runtimeConfig.proxyWsPath ?? process.env.NEXT_PUBLIC_TERMINAL_WS_PATH;
  if (proxyWsPath) {
    const basePath = proxyWsPath.replace(/\/ws\/?$/, "");
    return `${protocol}//${loc.host}${basePath}/mux`;
  }

  // Port-less or standard ports: use path-based routing (reverse proxy expected)
  if (loc.port === "" || loc.port === "443" || loc.port === "80") {
    return `${protocol}//${loc.hostname}/ao-terminal-mux`;
  }

  // Direct port connection — prefer runtime-configured port, fall back to env/default
  const port = runtimeConfig.directTerminalPort ?? process.env.NEXT_PUBLIC_DIRECT_TERMINAL_PORT ?? "14801";
  return `${protocol}//${loc.hostname}:${port}/mux`;
}

export function MuxProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef(new Map<string, Set<(data: string) => void>>());
  const openedTerminalsRef = useRef(new Set<string>());
  const terminalGrantCacheRef = useRef(new Map<string, TerminalGrantCacheEntry>());
  const terminalGrantInflightRef = useRef(new Map<string, Promise<string>>());
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "disconnected">(
    "connecting",
  );
  const [sessions, setSessions] = useState<SessionPatch[]>([]);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runtimeConfigRef = useRef<{ directTerminalPort?: string; proxyWsPath?: string }>({});
  const isDestroyedRef = useRef(false);

  const isTerminalDesired = useCallback((id: string): boolean => {
    return openedTerminalsRef.current.has(id) || (subscribersRef.current.get(id)?.size ?? 0) > 0;
  }, []);

  const fetchTerminalGrant = useCallback(async (id: string, forceRefresh = false): Promise<string> => {
    const cached = terminalGrantCacheRef.current.get(id);
    const now = Date.now();
    if (!forceRefresh && cached && cached.expiresAtMs - now > TERMINAL_GRANT_SKEW_MS) {
      return cached.token;
    }

    if (!forceRefresh) {
      const inflight = terminalGrantInflightRef.current.get(id);
      if (inflight) {
        return inflight;
      }
    }

    const request = (async () => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/terminal`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`Failed to authorize terminal: HTTP ${res.status}`);
      }

      const data = (await res.json()) as TerminalGrantResponse;
      if (typeof data.token !== "string" || typeof data.expiresAt !== "string") {
        throw new Error("Terminal authorization response was invalid");
      }

      const expiresAtMs = Date.parse(data.expiresAt);
      if (Number.isNaN(expiresAtMs)) {
        throw new Error("Terminal authorization expiry was invalid");
      }

      terminalGrantCacheRef.current.set(id, { token: data.token, expiresAtMs });
      return data.token;
    })();

    terminalGrantInflightRef.current.set(id, request);

    try {
      return await request;
    } finally {
      if (terminalGrantInflightRef.current.get(id) === request) {
        terminalGrantInflightRef.current.delete(id);
      }
    }
  }, []);

  const sendTerminalOpen = useCallback(async (id: string, forceRefresh = false) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const token = await fetchTerminalGrant(id, forceRefresh);
      if (
        wsRef.current !== ws ||
        ws.readyState !== WebSocket.OPEN ||
        !isTerminalDesired(id)
      ) {
        return;
      }

      const openMsg: ClientMessage = {
        ch: "terminal",
        id,
        type: "open",
        token,
      };
      ws.send(JSON.stringify(openMsg));
    } catch (err) {
      console.error(
        `[MuxProvider] Failed to authorize terminal ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }, [fetchTerminalGrant, isTerminalDesired]);

  const connect = useCallback(async () => {
    if (wsRef.current) {
      return;
    }

    setStatus("connecting");

    let muxToken: string | undefined;
    try {
      const muxRes = await fetch("/api/mux/connect", { cache: "no-store" });
      if (muxRes.ok) {
        const data = (await muxRes.json()) as { token?: unknown };
        if (typeof data.token === "string" && data.token.length > 0) {
          muxToken = data.token;
        }
      }
    } catch {
      // ignore — handled below
    }

    if (!muxToken) {
      console.error("[MuxProvider] Mux connect token unavailable — cannot open WebSocket");
      setStatus("disconnected");
      return;
    }

    try {
      const baseUrl = buildMuxWsUrl(runtimeConfigRef.current);
      const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(muxToken)}`;
      console.log("[MuxProvider] Connecting to", baseUrl);
      const ws = new WebSocket(url);
      // Assign immediately so cleanup can close it even during CONNECTING state
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (isDestroyedRef.current) {
          ws.close();
          return;
        }
        console.log("[MuxProvider] Connected");
        setStatus("connected");
        reconnectAttempt.current = 0;

        // Re-open previously opened terminals
        for (const terminalId of openedTerminalsRef.current) {
          void sendTerminalOpen(terminalId);
        }

        // Always subscribe to sessions
        const subMsg: ClientMessage = {
          ch: "subscribe",
          topics: ["sessions"],
        };
        ws.send(JSON.stringify(subMsg));
      });

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;

          if (msg.ch === "terminal") {
            if (msg.type === "data") {
              // Push to subscribers
              const subs = subscribersRef.current.get(msg.id);
              if (subs) {
                for (const callback of subs) {
                  callback(msg.data);
                }
              }
            } else if (msg.type === "opened") {
              // Ignore stale open acks that arrive after the terminal was closed
              // client-side while auth/open was still in flight.
              if (isTerminalDesired(msg.id)) {
                openedTerminalsRef.current.add(msg.id);
              } else if (ws.readyState === WebSocket.OPEN) {
                const closeMsg: ClientMessage = {
                  ch: "terminal",
                  id: msg.id,
                  type: "close",
                };
                ws.send(JSON.stringify(closeMsg));
              }
            } else if (msg.type === "exited") {
              // PTY exited and could not be re-attached — remove so it isn't
              // re-opened on reconnect, and surface a terminal-level error chunk
              openedTerminalsRef.current.delete(msg.id);
              const subs = subscribersRef.current.get(msg.id);
              if (subs) {
                const notice = `\r\n\x1b[31m[Terminal exited with code ${msg.code}]\x1b[0m\r\n`;
                for (const callback of subs) {
                  callback(notice);
                }
              }
            } else if (msg.type === "error") {
              console.error(`[MuxProvider] Terminal error for ${msg.id}:`, msg.message);
            }
          } else if (msg.ch === "sessions" && msg.type === "snapshot") {
            setSessions(msg.sessions);
          }
        } catch (err) {
          console.error("[MuxProvider] Error processing message:", err);
        }
      });

      ws.addEventListener("error", (err) => {
        console.error("[MuxProvider] WebSocket error:", err);
      });

      ws.addEventListener("close", () => {
        console.log("[MuxProvider] Disconnected");
        if (wsRef.current === ws) wsRef.current = null;

        // Don't reconnect if the provider has been unmounted
        if (isDestroyedRef.current) return;

        // Reconnect with exponential backoff
        const delayMs = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 30_000);
        reconnectAttempt.current += 1;
        setStatus("reconnecting");

        reconnectTimer.current = setTimeout(() => {
          console.log(`[MuxProvider] Reconnecting (attempt ${reconnectAttempt.current})...`);
          void connect();
        }, delayMs);
      });
    } catch (err) {
      console.error("[MuxProvider] Failed to create WebSocket:", err);
      setStatus("disconnected");
    }
  }, [isTerminalDesired, sendTerminalOpen]);

  // Fetch runtime config then connect. This ensures buildMuxWsUrl() has the
  // server-configured port/path before the WebSocket is opened.
  useEffect(() => {
    // Reset destroyed flag so StrictMode double-invoke works correctly:
    // cleanup sets it to true, but the re-run must treat itself as alive.
    isDestroyedRef.current = false;
    let cancelled = false;

    const init = async () => {
      try {
        const res = await fetch("/api/runtime/terminal");
        if (res.ok) {
          const data = (await res.json()) as RuntimeTerminalConfig;
          runtimeConfigRef.current = {
            directTerminalPort: normalizePortValue(data.directTerminalPort),
            proxyWsPath: normalizePathValue(data.proxyWsPath),
          };
        }
      } catch {
        // Ignore — fall back to env/default values
      }
      if (!cancelled) connect();
    };

    void init();

    return () => {
      cancelled = true;
      isDestroyedRef.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribeTerminal = useCallback(
    (id: string, callback: (data: string) => void): (() => void) => {
      // Add to subscribers
      let subs = subscribersRef.current.get(id);
      if (!subs) {
        subs = new Set();
        subscribersRef.current.set(id, subs);
      }
      subs.add(callback);

      // Request open if not already open
      if (!openedTerminalsRef.current.has(id) && wsRef.current?.readyState === WebSocket.OPEN) {
        void sendTerminalOpen(id);
      }

      // Return unsubscribe function
      return () => {
        const subs = subscribersRef.current.get(id);
        if (subs) {
          subs.delete(callback);
          if (subs.size === 0) {
            subscribersRef.current.delete(id);
          }
        }
      };
    },
    [sendTerminalOpen],
  );

  const writeTerminal = useCallback((id: string, data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = {
        ch: "terminal",
        id,
        type: "data",
        data,
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const openTerminal = useCallback((id: string) => {
    openedTerminalsRef.current.add(id);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      void sendTerminalOpen(id);
    }
  }, [sendTerminalOpen]);

  const closeTerminal = useCallback((id: string) => {
    openedTerminalsRef.current.delete(id);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = {
        ch: "terminal",
        id,
        type: "close",
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const resizeTerminal = useCallback((id: string, cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = {
        ch: "terminal",
        id,
        type: "resize",
        cols,
        rows,
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const contextValue: MuxContextValue = useMemo(
    () => ({
      subscribeTerminal,
      writeTerminal,
      openTerminal,
      closeTerminal,
      resizeTerminal,
      status,
      sessions,
    }),
    [subscribeTerminal, writeTerminal, openTerminal, closeTerminal, resizeTerminal, status, sessions],
  );

  return <MuxContext.Provider value={contextValue}>{children}</MuxContext.Provider>;
}
