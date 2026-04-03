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
  terminals: string[];
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
  const buffersRef = useRef(new Map<string, string[]>());
  const bufferBytesRef = useRef(new Map<string, number>());
  const openedTerminalsRef = useRef(new Set<string>());
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "disconnected">(
    "connecting",
  );
  const [sessions, setSessions] = useState<SessionPatch[]>([]);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runtimeConfigRef = useRef<{ directTerminalPort?: string; proxyWsPath?: string }>({});
  const sessionSubscribedRef = useRef(false);

  const connect = useCallback(() => {
    if (wsRef.current) {
      return;
    }

    setStatus("connecting");

    try {
      const url = buildMuxWsUrl(runtimeConfigRef.current);
      console.log("[MuxProvider] Connecting to", url);
      const ws = new WebSocket(url);

      ws.addEventListener("open", () => {
        console.log("[MuxProvider] Connected");
        wsRef.current = ws;
        setStatus("connected");
        reconnectAttempt.current = 0;

        // Re-open previously opened terminals
        for (const terminalId of openedTerminalsRef.current) {
          const openMsg: ClientMessage = {
            ch: "terminal",
            id: terminalId,
            type: "open",
          };
          ws.send(JSON.stringify(openMsg));
        }

        // Always subscribe to sessions
        sessionSubscribedRef.current = true;
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

              // Update buffer
              const buffer = buffersRef.current.get(msg.id) ?? [];
              buffer.push(msg.data);
              buffersRef.current.set(msg.id, buffer);

              let bytes = bufferBytesRef.current.get(msg.id) ?? 0;
              bytes += Buffer.byteLength(msg.data, "utf8");
              bufferBytesRef.current.set(msg.id, bytes);

              // Trim buffer if needed (50KB limit)
              const RING_BUFFER_MAX = 50 * 1024;
              if (bytes > RING_BUFFER_MAX) {
                while (bytes > RING_BUFFER_MAX && buffer.length > 0) {
                  const removed = buffer.shift() ?? "";
                  bytes -= Buffer.byteLength(removed, "utf8");
                }
                bufferBytesRef.current.set(msg.id, bytes);
              }
            } else if (msg.type === "opened") {
              // Terminal opened successfully
              openedTerminalsRef.current.add(msg.id);
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
        wsRef.current = null;

        // Reconnect with exponential backoff
        const delayMs = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 30_000);
        reconnectAttempt.current += 1;
        setStatus("reconnecting");

        reconnectTimer.current = setTimeout(() => {
          console.log(`[MuxProvider] Reconnecting (attempt ${reconnectAttempt.current})...`);
          connect();
        }, delayMs);
      });
    } catch (err) {
      console.error("[MuxProvider] Failed to create WebSocket:", err);
      setStatus("disconnected");
    }
  }, []);

  // Fetch runtime config then connect. This ensures buildMuxWsUrl() has the
  // server-configured port/path before the WebSocket is opened.
  useEffect(() => {
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
        const openMsg: ClientMessage = {
          ch: "terminal",
          id,
          type: "open",
        };
        wsRef.current.send(JSON.stringify(openMsg));
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
    [],
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
      const msg: ClientMessage = {
        ch: "terminal",
        id,
        type: "open",
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

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
      terminals: Array.from(openedTerminalsRef.current),
    }),
    [subscribeTerminal, writeTerminal, openTerminal, closeTerminal, resizeTerminal, status, sessions],
  );

  return <MuxContext.Provider value={contextValue}>{children}</MuxContext.Provider>;
}
