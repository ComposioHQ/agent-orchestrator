"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { cn } from "@/lib/cn";
import {
  useTerminalSettings,
  getThemePreset,
  TerminalSettingsPanel,
  THEME_PRESETS,
} from "./TerminalSettings";

// Import xterm CSS (must be imported in client component)
import "xterm/css/xterm.css";

// Dynamically import xterm types for TypeScript
import type { ITheme, Terminal as TerminalType } from "xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import type { SearchAddon as SearchAddonType } from "@xterm/addon-search";

interface DirectTerminalProps {
  sessionId: string;
  startFullscreen?: boolean;
  /** Visual variant. Orchestrator keeps the same design-system blue accent as the rest of the app. */
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
    cursor: "#58a6ff",
    selDark: "rgba(88, 166, 255, 0.3)",
    selLight: "rgba(91, 126, 248, 0.25)",
  };
  const orchAccent = agentAccent;
  const accent = variant === "orchestrator" ? orchAccent : agentAccent;

  // Default dark theme uses the GitHub Dark palette (first preset)
  const githubDark = THEME_PRESETS[0].dark;
  const dark: ITheme = {
    ...githubDark,
    cursor: accent.cursor,
    cursorAccent: githubDark.background,
    selectionBackground: accent.selDark,
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
 */
export function DirectTerminal({
  sessionId,
  startFullscreen = false,
  variant = "agent",
  height = "max(440px, calc(100dvh - 440px))",
  isOpenCodeSession = false,
  reloadCommand,
}: DirectTerminalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();
  const terminalThemes = useMemo(() => buildTerminalThemes(variant), [variant]);
  const [settings, updateSettings] = useTerminalSettings();

  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<TerminalType | null>(null);
  const fitAddon = useRef<FitAddonType | null>(null);
  const searchAddon = useRef<SearchAddonType | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const permanentErrorRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(startFullscreen);
  const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Search handlers
  const handleSearchToggle = useCallback(() => {
    setShowSearch((prev) => {
      if (!prev) {
        setTimeout(() => searchInputRef.current?.focus(), 50);
      } else {
        searchAddon.current?.clearDecorations();
        setSearchQuery("");
      }
      return !prev;
    });
  }, []);

  const handleSearchNext = useCallback(() => {
    if (searchQuery && searchAddon.current) {
      searchAddon.current.findNext(searchQuery);
    }
  }, [searchQuery]);

  const handleSearchPrev = useCallback(() => {
    if (searchQuery && searchAddon.current) {
      searchAddon.current.findPrevious(searchQuery);
    }
  }, [searchQuery]);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Reset reconnection state when sessionId changes
    permanentErrorRef.current = false;
    reconnectAttemptRef.current = 0;

    // Dynamically import xterm.js to avoid SSR issues
    let mounted = true;
    let cleanup: (() => void) | null = null;
    let inputDisposable: { dispose(): void } | null = null;

    const PERMANENT_CLOSE_CODES = new Set([4001, 4004]); // auth failure, session not found
    const MAX_RECONNECT_DELAY = 15_000;

    Promise.all([
      import("xterm").then((mod) => mod.Terminal),
      import("@xterm/addon-fit").then((mod) => mod.FitAddon),
      import("@xterm/addon-web-links").then((mod) => mod.WebLinksAddon),
      import("@xterm/addon-search").then((mod) => mod.SearchAddon),
      import("@xterm/addon-webgl").then((mod) => mod.WebglAddon).catch(() => null),
      document.fonts.ready,
    ])
      .then(([Terminal, FitAddon, WebLinksAddon, SearchAddon, WebglAddon]) => {
        if (!mounted || !terminalRef.current) return;

        const isDark = resolvedTheme !== "light";
        const activeTheme = isDark ? terminalThemes.dark : terminalThemes.light;

        // Initialize xterm.js Terminal
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: settings.fontSize,
          cursorStyle: settings.cursorStyle,
          fontFamily:
            'var(--font-jetbrains-mono), "JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
          theme: activeTheme,
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

        // Add SearchAddon
        const search = new SearchAddon();
        terminal.loadAddon(search);
        searchAddon.current = search;

        // Register XDA (Extended Device Attributes) handler for tmux clipboard support
        terminal.parser.registerCsiHandler(
          { prefix: ">", final: "q" },
          () => {
            terminal.write("\x1bP>|XTerm(370)\x1b\\");
            return true;
          },
        );

        // Register OSC 52 handler for clipboard support
        terminal.parser.registerOscHandler(52, (data) => {
          const parts = data.split(";");
          if (parts.length < 2) return false;
          const b64 = parts[parts.length - 1];
          try {
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

        // Load WebGL addon with canvas fallback
        if (WebglAddon) {
          try {
            terminal.loadAddon(new WebglAddon());
          } catch {
            // Canvas fallback — no action needed
          }
        }

        // Fit terminal to container
        fit.fit();

        // Runtime WS config cache
        const runtimeConnectionConfig: TerminalConnectionConfig = {};
        let runtimeFetchDone = false;

        // ── Preserve selection while terminal receives output ────────
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

        // Intercept Cmd+C (Mac) and Ctrl+Shift+C (Linux/Win) for copy
        terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.type !== "keydown") return true;

          const isCopy =
            (e.metaKey && !e.ctrlKey && !e.altKey && e.code === "KeyC") ||
            (e.ctrlKey && e.shiftKey && e.code === "KeyC");
          if (isCopy && terminal.hasSelection()) {
            navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
            terminal.clearSelection();
            return false;
          }

          return true;
        });

        // Handle window resize
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
              // Runtime config endpoint is optional
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

          const websocket = new WebSocket(wsUrl);
          ws.current = websocket;
          websocket.binaryType = "arraybuffer";

          websocket.onopen = () => {
            reconnectAttemptRef.current = 0;
            setStatus("connected");
            setError(null);

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
            if (!mounted) return;

            if (PERMANENT_CLOSE_CODES.has(event.code)) {
              permanentErrorRef.current = true;
              setStatus("error");
              setError(event.reason || `Connection refused (${event.code})`);
              return;
            }

            const attempt = reconnectAttemptRef.current;
            const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
            reconnectAttemptRef.current = attempt + 1;

            setStatus("connecting");
            setError(null);

            reconnectTimerRef.current = setTimeout(() => {
              void connectWebSocket();
            }, delay);
          };
        }

        void connectWebSocket();

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
  }, [sessionId, variant]);

  // Apply theme preset changes
  useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal) return;
    const isDark = resolvedTheme !== "light";
    if (isDark) {
      const preset = getThemePreset(settings.themeName);
      if (preset) {
        terminal.options.theme = preset.dark;
      } else {
        terminal.options.theme = terminalThemes.dark;
      }
    } else {
      terminal.options.theme = terminalThemes.light;
    }
    terminal.options.minimumContrastRatio = isDark ? 1 : 7;
  }, [resolvedTheme, terminalThemes, settings.themeName]);

  // Apply font size and cursor style changes
  useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal) return;
    terminal.options.fontSize = settings.fontSize;
    terminal.options.cursorStyle = settings.cursorStyle;
    fitAddon.current?.fit();
  }, [settings.fontSize, settings.cursorStyle]);

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

      const currentHeight = container.getBoundingClientRect().height;
      const settled = lastHeight >= 0 && Math.abs(currentHeight - lastHeight) < 1;
      lastHeight = currentHeight;

      if (!settled && resizeAttempts < maxAttempts) {
        rafId = requestAnimationFrame(resizeTerminal);
        return;
      }

      terminal.refresh(0, terminal.rows - 1);
      fit.fit();
      terminal.refresh(0, terminal.rows - 1);

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

    rafId = requestAnimationFrame(resizeTerminal);

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

  const accentColor = "var(--color-accent)";

  const statusDotClass =
    status === "connected"
      ? "terminal-dot--connected"
      : status === "error"
        ? "bg-[var(--color-status-error)]"
        : "terminal-dot--connecting";

  const statusBadgeText =
    status === "connected" ? "CONNECTED" : status === "error" ? "ERROR" : "RECONNECTING";

  const statusBadgeClass =
    status === "connected"
      ? "text-[var(--color-status-ready)]"
      : status === "error"
        ? "text-[var(--color-status-error)]"
        : "text-[var(--color-status-attention)]";

  // Resolve the background color for the container from the active theme
  const containerBg = useMemo(() => {
    if (resolvedTheme === "light") return "#fafafa";
    const preset = getThemePreset(settings.themeName);
    return preset?.dark.background ?? "#0d1117";
  }, [resolvedTheme, settings.themeName]);

  // Height of the top bar + status bar for fullscreen calc
  const chromeHeight = "74px"; // ~37px top + ~37px bottom

  return (
    <div
      className={cn(
        "terminal-container overflow-hidden border border-[#21262d]",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
      style={{
        background: containerBg,
        borderRadius: fullscreen ? 0 : 12,
        boxShadow: fullscreen
          ? "none"
          : "0 8px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      {/* ── Top bar chrome ──────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 border-b border-[#21262d] px-3 py-2"
        style={{
          background: "rgba(22, 27, 34, 0.8)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        {/* Connection dot */}
        <div className={cn("h-2.5 w-2.5 shrink-0 rounded-full", statusDotClass)} />
        {/* Session name */}
        <span className="font-[var(--font-mono)] text-[11px]" style={{ color: accentColor }}>
          {sessionId}
        </span>
        {/* Status badge */}
        <span
          className={cn("text-[9px] font-bold uppercase tracking-[0.08em]", statusBadgeClass)}
        >
          {statusBadgeText}
        </span>
        {/* XDA clipboard badge */}
        <span
          className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]"
          style={{
            color: accentColor,
            background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
            borderRadius: "3px",
          }}
        >
          XDA
        </span>

        {/* Right side buttons */}
        <div className="ml-auto flex items-center gap-1">
          {isOpenCodeSession ? (
            <button
              onClick={handleReload}
              disabled={reloading || status !== "connected"}
              title="Restart OpenCode session"
              aria-label="Restart OpenCode session"
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
              style={{ borderRadius: "4px" }}
            >
              {reloading ? (
                <svg
                  className="h-3 w-3 animate-spin"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M12 3a9 9 0 109 9" />
                </svg>
              ) : (
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
              )}
            </button>
          ) : null}
          {reloadError ? (
            <span
              className="max-w-[30ch] truncate text-[10px] font-medium text-[var(--color-status-error)]"
              title={reloadError}
            >
              {reloadError}
            </span>
          ) : null}

          {/* Search button */}
          <button
            onClick={handleSearchToggle}
            title="Search terminal (Ctrl+F)"
            aria-label="Search terminal"
            className={cn(
              "flex items-center px-2 py-1 text-[var(--color-text-tertiary)] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--color-text-primary)]",
              showSearch && "bg-[rgba(255,255,255,0.08)] text-[var(--color-text-primary)]",
            )}
            style={{ borderRadius: "4px" }}
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </button>

          {/* Settings button */}
          <div className="relative">
            <button
              onClick={() => setShowSettings((prev) => !prev)}
              title="Terminal settings"
              aria-label="Terminal settings"
              className={cn(
                "flex items-center px-2 py-1 text-[var(--color-text-tertiary)] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--color-text-primary)]",
                showSettings && "bg-[rgba(255,255,255,0.08)] text-[var(--color-text-primary)]",
              )}
              style={{ borderRadius: "4px" }}
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            {showSettings ? (
              <TerminalSettingsPanel
                settings={settings}
                onUpdate={updateSettings}
                onClose={() => setShowSettings(false)}
              />
            ) : null}
          </div>

          {/* Fullscreen button */}
          <button
            onClick={() => setFullscreen(!fullscreen)}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="flex items-center px-2 py-1 text-[var(--color-text-tertiary)] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--color-text-primary)]"
            style={{ borderRadius: "4px" }}
          >
            {fullscreen ? (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* ── Search bar ──────────────────────────────────────────────── */}
      {showSearch ? (
        <div className="flex items-center gap-2 border-b border-[#21262d] bg-[rgba(22,27,34,0.9)] px-3 py-1.5">
          <svg className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value && searchAddon.current) {
                searchAddon.current.findNext(e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) handleSearchPrev();
                else handleSearchNext();
              }
              if (e.key === "Escape") handleSearchToggle();
            }}
            placeholder="Search..."
            className="flex-1 border-none bg-transparent font-[var(--font-mono)] text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
          <button
            onClick={handleSearchPrev}
            className="px-1 py-0.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
            title="Previous match"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </button>
          <button
            onClick={handleSearchNext}
            className="px-1 py-0.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
            title="Next match"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <button
            onClick={handleSearchToggle}
            className="px-1 py-0.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
            title="Close search"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : null}

      {/* ── Terminal area ───────────────────────────────────────────── */}
      <div
        ref={terminalRef}
        className={cn("w-full p-2")}
        style={{
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          height: fullscreen ? `calc(100dvh - ${chromeHeight})` : height,
        }}
      />

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between border-t border-[#21262d] px-3 py-1.5"
        style={{ background: "#161b22" }}
      >
        <div className="flex items-center gap-3">
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
            {settings.fontSize}px
          </span>
          {error && status === "error" ? (
            <span className="text-[11px] text-[var(--color-status-error)]">
              {error}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[var(--color-text-tertiary)]">
            WebGL
          </span>
        </div>
      </div>
    </div>
  );
}
