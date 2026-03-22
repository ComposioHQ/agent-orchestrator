"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";

import type { FitAddon as FitAddonType, Terminal as TerminalType } from "ghostty-web";

interface DirectTerminalProps {
  sessionId: string;
  startFullscreen?: boolean;
  /** Visual variant. "orchestrator" uses violet accent; "agent" (default) uses blue. */
  variant?: "agent" | "orchestrator";
  /** CSS height for the terminal container in normal (non-fullscreen) mode.
   *  Defaults to "max(440px, calc(100vh - 440px))". */
  height?: string;
  isOpenCodeSession?: boolean;
  reloadCommand?: string;
}

interface DirectTerminalLocation {
  protocol: string;
  hostname: string;
  host: string;
  port: string;
}

interface DirectTerminalWsUrlOptions {
  location: DirectTerminalLocation;
  sessionId: string;
  proxyWsPath?: string;
  directTerminalPort?: string;
}

type GhosttyWebModule = typeof import("ghostty-web");

let ghosttyWebInitPromise: Promise<GhosttyWebModule> | null = null;

function loadGhosttyWeb(): Promise<GhosttyWebModule> {
  if (!ghosttyWebInitPromise) {
    ghosttyWebInitPromise = import("ghostty-web").then(async (mod) => {
      await mod.init();
      return mod;
    });
  }
  return ghosttyWebInitPromise;
}

export function buildDirectTerminalWsUrl({
  location,
  sessionId,
  proxyWsPath,
  directTerminalPort,
}: DirectTerminalWsUrlOptions): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (proxyWsPath) {
    // Path-based proxy uses host so non-standard ports are preserved.
    return `${protocol}//${location.host}${proxyWsPath}?session=${encodeURIComponent(sessionId)}`;
  }

  if (location.port === "" || location.port === "443" || location.port === "80") {
    return `${protocol}//${location.hostname}/ao-terminal-ws?session=${encodeURIComponent(sessionId)}`;
  }

  const port = directTerminalPort ?? "14801";
  return `${protocol}//${location.hostname}:${port}/ws?session=${encodeURIComponent(sessionId)}`;
}

/** Direct Ghostty terminal with native WebSocket connection. */
export function DirectTerminal({
  sessionId,
  startFullscreen = false,
  variant = "agent",
  height = "max(440px, calc(100vh - 440px))",
  isOpenCodeSession = false,
  reloadCommand,
}: DirectTerminalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<TerminalType | null>(null);
  const fitAddon = useRef<FitAddonType | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const permanentErrorRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(startFullscreen);
  const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  // Update URL when fullscreen changes
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());

    if (fullscreen) {
      params.set("fullscreen", "true");
    } else {
      params.delete("fullscreen");
    }

    const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    router.replace(newUrl, { scroll: false });
  }, [fullscreen, pathname, router, searchParams]);

  async function handleReload(): Promise<void> {
    if (!isOpenCodeSession || reloading) return;
    setReloadError(null);
    setReloading(true);
    try {
      let commandToSend = reloadCommand;

      if (!commandToSend) {
        const remapRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/remap`, {
          method: "POST",
        });
        if (!remapRes.ok) {
          throw new Error(`Failed to remap OpenCode session: ${remapRes.status}`);
        }
        const remapData = (await remapRes.json()) as { opencodeSessionId?: unknown };
        if (
          typeof remapData.opencodeSessionId !== "string" ||
          remapData.opencodeSessionId.length === 0
        ) {
          throw new Error("Missing OpenCode session id after remap");
        }
        commandToSend = `/exit\nopencode --session ${remapData.opencodeSessionId}\n`;
      }

      const sendRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: commandToSend }),
      });
      if (!sendRes.ok) {
        throw new Error(`Failed to send reload command: ${sendRes.status}`);
      }
    } catch (err) {
      setReloadError(err instanceof Error ? err.message : "Failed to reload OpenCode session");
    } finally {
      setReloading(false);
    }
  }

  useEffect(() => {
    if (!terminalRef.current) return;

    // Reset reconnection state when sessionId changes
    permanentErrorRef.current = false;
    reconnectAttemptRef.current = 0;

    // Dynamically import ghostty-web to avoid SSR issues
    let mounted = true;
    let cleanup: (() => void) | null = null;
    let inputDisposable: { dispose(): void } | null = null;

    const PERMANENT_CLOSE_CODES = new Set([4001, 4004]); // auth failure, session not found
    const MAX_RECONNECT_DELAY = 15_000;

    loadGhosttyWeb()
      .then(({ Terminal, FitAddon, UrlRegexProvider }) => {
        if (!mounted || !terminalRef.current) return;

        // Cursor and selection color differ by variant:
        // agent = blue (#5b7ef8), orchestrator = violet (#a371f7)
        const cursorColor = variant === "orchestrator" ? "#a371f7" : "#5b7ef8";
        const selectionColor =
          variant === "orchestrator" ? "rgba(163, 113, 247, 0.25)" : "rgba(91, 126, 248, 0.3)";

        // Initialize Ghostty terminal
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
          theme: {
            background: "#0a0a0f",
            foreground: "#d4d4d8",
            cursor: cursorColor,
            cursorAccent: "#0a0a0f",
            selectionBackground: selectionColor,
            // ANSI colors — slightly warmer than pure defaults
            black: "#1a1a24",
            red: "#ef4444",
            green: "#22c55e",
            yellow: "#f59e0b",
            blue: "#5b7ef8",
            magenta: "#a371f7",
            cyan: "#22d3ee",
            white: "#d4d4d8",
            brightBlack: "#50506a",
            brightRed: "#f87171",
            brightGreen: "#4ade80",
            brightYellow: "#fbbf24",
            brightBlue: "#7b9cfb",
            brightMagenta: "#c084fc",
            brightCyan: "#67e8f9",
            brightWhite: "#eeeef5",
          },
          scrollback: 10000,
        });

        const fit = new FitAddon();
        terminal.loadAddon(fit);
        fitAddon.current = fit;

        terminal.registerLinkProvider(new UrlRegexProvider(terminal));

        // Open terminal in DOM
        terminal.open(terminalRef.current);
        terminalInstance.current = terminal;

        // Fit terminal to container
        fit.fit();

        // WebSocket URL (stable across reconnects)
        // When accessed via reverse proxy (HTTPS on standard port), use path-based
        // WebSocket endpoint instead of direct port access.
        const wsUrl = buildDirectTerminalWsUrl({
          location: window.location,
          sessionId,
          proxyWsPath: process.env.NEXT_PUBLIC_TERMINAL_WS_PATH,
          directTerminalPort: process.env.NEXT_PUBLIC_DIRECT_TERMINAL_PORT,
        });

        // ── Preserve selection while terminal receives output ────────
        // Terminal output can interrupt interactive selection/copy flows. We
        // buffer incoming data while a selection is active so the
        // highlight stays visible for Cmd+C. The buffer is flushed
        // when the selection is cleared (click, keypress, etc.).
        const writeBuffer: string[] = [];
        let selectionActive = false;
        let safetyTimer: ReturnType<typeof setTimeout> | null = null;
        let bufferBytes = 0;
        const MAX_BUFFER_BYTES = 1_048_576; // 1 MB

        const flushWriteBuffer = () => {
          if (safetyTimer) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
          }
          if (writeBuffer.length > 0) {
            terminal.write(writeBuffer.join(""));
            writeBuffer.length = 0;
            bufferBytes = 0;
          }
        };

        const selectionDisposable = terminal.onSelectionChange(() => {
          if (terminal.hasSelection()) {
            selectionActive = true;
            // Safety: flush after 5s to prevent unbounded buffering
            if (!safetyTimer) {
              safetyTimer = setTimeout(() => {
                selectionActive = false;
                flushWriteBuffer();
              }, 5_000);
            }
          } else {
            selectionActive = false;
            flushWriteBuffer();
          }
        });

        // Intercept Cmd+C (Mac) and Ctrl+Shift+C (Linux/Win) for copy.
        // Paste is handled by ghostty-web's internal input handling.
        terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.type !== "keydown") return false;

          // Cmd+C / Ctrl+Shift+C — copy selection
          const isCopy =
            (e.metaKey && !e.ctrlKey && !e.altKey && e.code === "KeyC") ||
            (e.ctrlKey && e.shiftKey && e.code === "KeyC");
          if (isCopy && terminal.hasSelection()) {
            navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
            // Clear selection so the terminal resumes receiving output
            terminal.clearSelection();
            e.preventDefault();
            return true;
          }

          return false;
        });

        // Handle window resize (works with whatever ws is current)
        const handleResize = () => {
          const currentWs = ws.current;
          if (fit && currentWs?.readyState === WebSocket.OPEN) {
            fit.fit();
            currentWs.send(
              JSON.stringify({
                type: "resize",
                cols: terminal.cols,
                rows: terminal.rows,
              }),
            );
          }
        };

        window.addEventListener("resize", handleResize);

        // Terminal input → current WebSocket
        inputDisposable = terminal.onData((data) => {
          if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(data);
          }
        });

        function connectWebSocket() {
          if (!mounted) return;

          console.log("[DirectTerminal] Connecting to:", wsUrl);
          const websocket = new WebSocket(wsUrl);
          ws.current = websocket;
          websocket.binaryType = "arraybuffer";

          websocket.onopen = () => {
            console.log("[DirectTerminal] WebSocket connected");
            reconnectAttemptRef.current = 0;
            setStatus("connected");
            setError(null);

            // Send initial size
            websocket.send(
              JSON.stringify({
                type: "resize",
                cols: terminal.cols,
                rows: terminal.rows,
              }),
            );
          };

          websocket.onmessage = (event) => {
            const data =
              typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
            if (selectionActive) {
              writeBuffer.push(data);
              bufferBytes += data.length;
              // Flush if buffer exceeds 1 MB to prevent OOM
              if (bufferBytes > MAX_BUFFER_BYTES) {
                selectionActive = false;
                flushWriteBuffer();
              }
            } else {
              terminal.write(data);
            }
          };

          websocket.onerror = (event) => {
            console.error("[DirectTerminal] WebSocket error:", event);
          };

          websocket.onclose = (event) => {
            console.log("[DirectTerminal] WebSocket closed:", event.code, event.reason);

            if (!mounted) return;

            // Permanent errors — don't retry
            if (PERMANENT_CLOSE_CODES.has(event.code)) {
              permanentErrorRef.current = true;
              setStatus("error");
              setError(event.reason || `Connection refused (${event.code})`);
              return;
            }

            // Transient failure — schedule reconnect with exponential backoff
            const attempt = reconnectAttemptRef.current;
            const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
            reconnectAttemptRef.current = attempt + 1;

            console.log(`[DirectTerminal] Reconnecting in ${delay}ms (attempt ${attempt + 1})`);
            setStatus("connecting");
            setError(null);

            reconnectTimerRef.current = setTimeout(connectWebSocket, delay);
          };
        }

        connectWebSocket();

        // Store cleanup function to be called from useEffect cleanup
        cleanup = () => {
          selectionDisposable.dispose();
          if (safetyTimer) clearTimeout(safetyTimer);
          window.removeEventListener("resize", handleResize);
          inputDisposable?.dispose();
          inputDisposable = null;
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          ws.current?.close();
          terminal.dispose();
        };
      })
      .catch((err) => {
        console.error("[DirectTerminal] Failed to load ghostty-web:", err);
        permanentErrorRef.current = true;
        setStatus("error");
        setError("Failed to load terminal");
      });

    return () => {
      mounted = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      cleanup?.();
    };
  }, [sessionId, variant]);

  // Re-fit terminal when fullscreen changes
  useEffect(() => {
    const fit = fitAddon.current;
    const terminal = terminalInstance.current;
    const websocket = ws.current;
    const container = terminalRef.current;

    if (!fit || !terminal || !websocket || websocket.readyState !== WebSocket.OPEN || !container) {
      return;
    }

    let resizeAttempts = 0;
    const maxAttempts = 60;
    let cancelled = false;
    let rafId = 0;
    let lastHeight = -1;

    const resizeTerminal = () => {
      if (cancelled) return;
      resizeAttempts++;

      // Wait for the container height to stabilise (CSS transition finished)
      const currentHeight = container.getBoundingClientRect().height;
      const settled = lastHeight >= 0 && Math.abs(currentHeight - lastHeight) < 1;
      lastHeight = currentHeight;

      if (!settled && resizeAttempts < maxAttempts) {
        // Container is still transitioning, try again next frame
        rafId = requestAnimationFrame(resizeTerminal);
        return;
      }

      // Container is at target size, now resize terminal
      fit.fit();

      // Send new size to server (use ws.current in case WebSocket reconnected)
      const currentWs = ws.current;
      if (currentWs?.readyState === WebSocket.OPEN) {
        currentWs.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    };

    // Start resize polling
    rafId = requestAnimationFrame(resizeTerminal);

    // Also try on transitionend
    const handleTransitionEnd = (e: TransitionEvent) => {
      if (cancelled) return;
      if (e.target === container.parentElement) {
        resizeAttempts = 0;
        lastHeight = -1;
        setTimeout(() => {
          if (!cancelled) rafId = requestAnimationFrame(resizeTerminal);
        }, 50);
      }
    };

    const parent = container.parentElement;
    parent?.addEventListener("transitionend", handleTransitionEnd);

    // Backup timers in case RAF polling doesn't work
    const timer1 = setTimeout(() => {
      if (cancelled) return;
      resizeAttempts = 0;
      lastHeight = -1;
      resizeTerminal();
    }, 300);
    const timer2 = setTimeout(() => {
      if (cancelled) return;
      resizeAttempts = 0;
      lastHeight = -1;
      resizeTerminal();
    }, 600);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      parent?.removeEventListener("transitionend", handleTransitionEnd);
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [fullscreen]);

  const accentColor =
    variant === "orchestrator" ? "var(--color-accent-violet)" : "var(--color-accent)";

  const statusDotClass =
    status === "connected"
      ? "bg-[var(--color-status-ready)]"
      : status === "error"
        ? "bg-[var(--color-status-error)]"
        : "bg-[var(--color-status-attention)] animate-[pulse_1.5s_ease-in-out_infinite]";

  const statusText =
    status === "connected" ? "Connected" : status === "error" ? (error ?? "Error") : "Connecting…";

  const statusTextColor =
    status === "connected"
      ? "text-[var(--color-status-ready)]"
      : status === "error"
        ? "text-[var(--color-status-error)]"
        : "text-[var(--color-text-tertiary)]";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[6px] border border-[var(--color-border-default)]",
        "bg-[#0a0a0f]",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
    >
      {/* Terminal chrome bar */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2">
        <div className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass)} />
        <span className="font-[var(--font-mono)] text-[11px]" style={{ color: accentColor }}>
          {sessionId}
        </span>
        <span
          className={cn("text-[10px] font-medium uppercase tracking-[0.06em]", statusTextColor)}
        >
          {statusText}
        </span>
        {/* Emulator badge */}
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]"
          style={{
            color: accentColor,
            background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
          }}
        >
          Ghostty
        </span>
        {isOpenCodeSession ? (
          <button
            onClick={handleReload}
            disabled={reloading || status !== "connected"}
            title="Restart OpenCode session (/exit then resume mapped session)"
            aria-label="Restart OpenCode session"
            className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {reloading ? (
              <>
                <svg
                  className="h-3 w-3 animate-spin"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M12 3a9 9 0 109 9" />
                </svg>
                restarting
              </>
            ) : (
              <>
                <svg
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M21 12a9 9 0 11-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
                restart
              </>
            )}
          </button>
        ) : null}
        {reloadError ? (
          <span
            className="max-w-[40ch] truncate text-[10px] font-medium text-[var(--color-status-error)]"
            title={reloadError}
          >
            {reloadError}
          </span>
        ) : null}
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]",
            !isOpenCodeSession && "ml-auto",
          )}
        >
          {fullscreen ? (
            <>
              <svg
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              </svg>
              exit fullscreen
            </>
          ) : (
            <>
              <svg
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
              </svg>
              fullscreen
            </>
          )}
        </button>
      </div>
      {/* Terminal area */}
      <div
        ref={terminalRef}
        className={cn("w-full p-1.5")}
        style={{
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          height: fullscreen ? "calc(100vh - 37px)" : height,
        }}
      />
    </div>
  );
}
