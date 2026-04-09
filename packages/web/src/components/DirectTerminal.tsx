"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { cn } from "@/lib/cn";

// Import xterm CSS (must be imported in client component)
import "xterm/css/xterm.css";

// Dynamically import xterm types for TypeScript
import type { ITheme, Terminal as TerminalType } from "xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";

interface DirectTerminalProps {
  sessionId: string;
  startFullscreen?: boolean;
  /** Visual variant. Orchestrator keeps the same design-system blue accent as the rest of the app. */
  variant?: "agent" | "orchestrator";
  appearance?: "theme" | "dark";
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

interface RuntimeTerminalConfigResponse {
  directTerminalPort?: unknown;
  proxyWsPath?: unknown;
}

interface TerminalConnectionConfig {
  directTerminalPort?: string;
  proxyWsPath?: string;
}

type TerminalVariant = "agent" | "orchestrator";

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

function parseRuntimeTerminalConfig(payload: unknown): TerminalConnectionConfig {
  const response = (payload ?? {}) as RuntimeTerminalConfigResponse;
  return {
    directTerminalPort: normalizePortValue(response.directTerminalPort),
    proxyWsPath: normalizePathValue(response.proxyWsPath),
  };
}

export function buildTerminalThemes(variant: TerminalVariant): { dark: ITheme; light: ITheme } {
  const agentAccent = {
    cursor: "#5b7ef8",
    selDark: "rgba(91, 126, 248, 0.30)",
    selLight: "rgba(91, 126, 248, 0.25)",
  };
  const orchAccent = agentAccent;
  const accent = variant === "orchestrator" ? orchAccent : agentAccent;

  const dark: ITheme = {
    background: "#0a0a0f",
    foreground: "#d4d4d8",
    cursor: accent.cursor,
    cursorAccent: "#0a0a0f",
    selectionBackground: accent.selDark,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
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
  };

  const light: ITheme = {
    background: "#fafafa",
    foreground: "#24292f",
    cursor: accent.cursor,
    cursorAccent: "#fafafa",
    selectionBackground: accent.selLight,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.15)",
    // ANSI colors — darkened for legibility on #fafafa terminal background
    black: "#24292f",
    red: "#b42318",
    green: "#1f7a3d",
    yellow: "#8a5a00",
    blue: "#175cd3",
    magenta: "#8e24aa",
    cyan: "#0b7285",
    white: "#4b5563",
    brightBlack: "#374151",
    brightRed: "#912018",
    brightGreen: "#176639",
    brightYellow: "#6f4a00",
    brightBlue: "#1d4ed8",
    brightMagenta: "#7b1fa2",
    brightCyan: "#155e75",
    brightWhite: "#374151",
  };

  return { dark, light };
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

/**
 * Direct xterm.js terminal with native WebSocket connection.
 * Implements Extended Device Attributes (XDA) handler to enable
 * tmux clipboard support (OSC 52) without requiring iTerm2 attachment.
 *
 * Based on DeepWiki analysis:
 * - tmux queries for XDA (CSI > q / XTVERSION) to detect terminal type
 * - When tmux sees "XTerm(" in response, it enables TTYC_MS (clipboard)
 * - xterm.js doesn't implement XDA by default, so we register custom handler
 */
export function DirectTerminal({
  sessionId,
  startFullscreen = false,
  variant = "agent",
  appearance = "theme",
  height = "max(440px, calc(100dvh - 440px))",
  isOpenCodeSession = false,
  reloadCommand,
}: DirectTerminalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();
  const terminalThemes = useMemo(() => buildTerminalThemes(variant), [variant]);

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

    // Dynamically import xterm.js to avoid SSR issues
    let mounted = true;
    let cleanup: (() => void) | null = null;
    let inputDisposable: { dispose(): void } | null = null;

    const PERMANENT_CLOSE_CODES = new Set([1008, 4001, 4004]); // policy violation, auth failure, session not found
    const MAX_RECONNECT_DELAY = 15_000;
    const MAX_RECONNECT_ATTEMPTS = 8;

    Promise.all([
      import("xterm").then((mod) => mod.Terminal),
      import("@xterm/addon-fit").then((mod) => mod.FitAddon),
      import("@xterm/addon-web-links").then((mod) => mod.WebLinksAddon),
      document.fonts.ready,
    ])
      .then(([Terminal, FitAddon, WebLinksAddon]) => {
        if (!mounted || !terminalRef.current) return;

        const isDark = appearance === "dark" || resolvedTheme !== "light";
        const activeTheme = isDark ? terminalThemes.dark : terminalThemes.light;

        // Initialize xterm.js Terminal
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily:
            'var(--font-jetbrains-mono), "JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
          theme: activeTheme,
          // Light mode needs an explicit contrast floor because agent UIs often emit
          // dim/faint ANSI sequences that become unreadable on a near-white background.
          minimumContrastRatio: isDark ? 1 : 7,
          scrollback: 10000,
          allowProposedApi: true,
          fastScrollModifier: "alt",
          fastScrollSensitivity: 3,
          scrollSensitivity: 1,
        });

        // Add FitAddon for responsive sizing
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        fitAddon.current = fit;

        // Add WebLinksAddon for clickable links
        const webLinks = new WebLinksAddon();
        terminal.loadAddon(webLinks);

        // **CRITICAL FIX**: Register XDA (Extended Device Attributes) handler
        // This makes tmux recognize our terminal and enable clipboard support
        terminal.parser.registerCsiHandler(
          { prefix: ">", final: "q" }, // CSI > q is XTVERSION / XDA
          () => {
            // Respond with XTerm identification that tmux recognizes
            // tmux looks for "XTerm(" in the response (see tmux tty-keys.c)
            // Format: DCS > | XTerm(version) ST
            // DCS = \x1bP, ST = \x1b\\
            terminal.write("\x1bP>|XTerm(370)\x1b\\");
            console.log("[DirectTerminal] Sent XDA response for clipboard support");
            return true; // Handled
          },
        );

        // Register OSC 52 handler for clipboard support
        // tmux sends OSC 52 with base64-encoded text when copying
        terminal.parser.registerOscHandler(52, (data) => {
          const parts = data.split(";");
          if (parts.length < 2) return false;
          const b64 = parts[parts.length - 1];
          try {
            // Decode base64 → binary string → Uint8Array → UTF-8 text
            // atob() alone only handles Latin-1; TextDecoder is needed for UTF-8
            const binary = atob(b64);
            const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
            const text = new TextDecoder().decode(bytes);
            navigator.clipboard?.writeText(text).catch(() => {});
          } catch {
            // Ignore decode errors
          }
          return true;
        });

        // Open terminal in DOM
        terminal.open(terminalRef.current);
        terminalInstance.current = terminal;

        // Fit terminal to container
        fit.fit();

        // Runtime WS config cache. We do not rely on build-time NEXT_PUBLIC_* here
        // because `ao start` can choose terminal ports dynamically at runtime.
        const runtimeConnectionConfig: TerminalConnectionConfig = {};
        let runtimeFetchDone = false;

        // ── Preserve selection while terminal receives output ────────
        // xterm.js clears the selection on every terminal.write(). We
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
        // Paste (Cmd+V / Ctrl+Shift+V) is handled natively by xterm.js
        // via its internal textarea — no custom handler needed.
        terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.type !== "keydown") return true;

          // Cmd+C / Ctrl+Shift+C — copy selection
          const isCopy =
            (e.metaKey && !e.ctrlKey && !e.altKey && e.code === "KeyC") ||
            (e.ctrlKey && e.shiftKey && e.code === "KeyC");
          if (isCopy && terminal.hasSelection()) {
            navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
            // Clear selection so the terminal resumes receiving output
            terminal.clearSelection();
            return false;
          }

          return true;
        });

        // Keep the terminal sized to its container instead of the window.
        const resizeObserver = new ResizeObserver(() => {
          fit.fit();
          const currentWs = ws.current;
          if (currentWs?.readyState === WebSocket.OPEN) {
            currentWs.send(
              JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
            );
          }
        });
        resizeObserver.observe(terminalRef.current);

        // Terminal input → current WebSocket
        inputDisposable = terminal.onData((data) => {
          if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(data);
          }
        });

        async function resolveConnectionConfig(): Promise<TerminalConnectionConfig> {
          const fromBuild: TerminalConnectionConfig = {
            proxyWsPath: normalizePathValue(process.env.NEXT_PUBLIC_TERMINAL_WS_PATH),
            directTerminalPort: normalizePortValue(process.env.NEXT_PUBLIC_DIRECT_TERMINAL_PORT),
          };

          if (!fromBuild.proxyWsPath && !runtimeFetchDone) {
            runtimeFetchDone = true;
            const controller = new AbortController();
            const fetchTimeout = setTimeout(() => controller.abort(), 1500);
            try {
              const response = await fetch("/api/runtime/terminal", {
                cache: "no-store",
                signal: controller.signal,
              });
              if (response.ok) {
                const runtimeConfig = parseRuntimeTerminalConfig(await response.json());
                runtimeConnectionConfig.proxyWsPath = runtimeConfig.proxyWsPath;
                runtimeConnectionConfig.directTerminalPort = runtimeConfig.directTerminalPort;
              }
            } catch {
              // Runtime config endpoint is optional (timeout or network failure); fallback to build-time values.
            } finally {
              clearTimeout(fetchTimeout);
            }
          }

          return {
            proxyWsPath: runtimeConnectionConfig.proxyWsPath ?? fromBuild.proxyWsPath,
            directTerminalPort:
              runtimeConnectionConfig.directTerminalPort ?? fromBuild.directTerminalPort,
          };
        }

        async function connectWebSocket() {
          if (!mounted) return;

          const config = await resolveConnectionConfig();
          if (!mounted) return;

          const wsUrl = buildDirectTerminalWsUrl({
            location: window.location,
            sessionId,
            proxyWsPath: config.proxyWsPath,
            directTerminalPort: config.directTerminalPort,
          });

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
            reconnectAttemptRef.current = attempt + 1;

            if (attempt >= MAX_RECONNECT_ATTEMPTS) {
              permanentErrorRef.current = true;
              setStatus("error");
              setError("Session unavailable — terminal process may have exited");
              return;
            }

            const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
            console.log(`[DirectTerminal] Reconnecting in ${delay}ms (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})`);
            setStatus("connecting");
            setError(null);

            reconnectTimerRef.current = setTimeout(() => {
              void connectWebSocket();
            }, delay);
          };
        }

        void connectWebSocket();

        // Store cleanup function to be called from useEffect cleanup
        cleanup = () => {
          selectionDisposable.dispose();
          if (safetyTimer) clearTimeout(safetyTimer);
          resizeObserver.disconnect();
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
        console.error("[DirectTerminal] Failed to load xterm.js:", err);
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
  }, [appearance, sessionId, variant]);

  // Live theme switching without terminal recreation
  useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal) return;
    const isDark = appearance === "dark" || resolvedTheme !== "light";
    terminal.options.theme = isDark ? terminalThemes.dark : terminalThemes.light;
    terminal.options.minimumContrastRatio = isDark ? 1 : 7;
  }, [appearance, resolvedTheme, terminalThemes]);

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
      terminal.refresh(0, terminal.rows - 1);
      fit.fit();
      terminal.refresh(0, terminal.rows - 1);

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

  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-[6px] border border-[var(--color-border-default)]",
        "bg-[#0a0908]",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
    >
      {/* Terminal chrome bar */}
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.025] px-[10px] py-[5px]">
        <div className="flex min-w-0 items-center gap-[7px]">
          <span className="font-[var(--font-mono)] text-[10px] text-white/30">
            {sessionId}
          </span>
          {status === "error" ? (
            <span className="max-w-[28ch] truncate text-[10px] font-medium text-[var(--color-status-error)]" title={error ?? "Error"}>
              {error ?? "Error"}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-[5px]">
          {isOpenCodeSession ? (
            <button
              onClick={handleReload}
              disabled={reloading || status !== "connected"}
              title="Restart OpenCode session"
              aria-label="Restart OpenCode session"
              className="flex h-6 w-6 items-center justify-center rounded-[4px] border border-white/10 bg-transparent text-white/35 transition-all hover:border-white/20 hover:bg-white/[0.04] hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <svg
                className={cn("h-[11px] w-[11px]", reloading && "animate-spin")}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M21 12a9 9 0 11-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
          ) : null}
          <button
            onClick={() => setFullscreen(!fullscreen)}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="flex h-6 w-6 items-center justify-center rounded-[4px] border border-white/10 bg-transparent text-white/35 transition-all hover:border-white/20 hover:bg-white/[0.04] hover:text-white/70"
          >
            {fullscreen ? (
              <svg
                className="h-[11px] w-[11px]"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              </svg>
            ) : (
              <svg
                className="h-[11px] w-[11px]"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {(reloadError && status !== "error") ? (
        <div className="border-b border-white/10 px-[10px] py-[5px] text-[10px] font-medium text-[var(--color-status-error)]">
          {reloadError}
        </div>
      ) : null}
      {/* Terminal area */}
      <div
        ref={terminalRef}
        className={cn("min-w-0 w-full")}
        style={{
          overflow: "hidden",
          display: "block",
          height: fullscreen ? "calc(100dvh - 35px)" : height,
        }}
      />
    </div>
  );
}
