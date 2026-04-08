"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { cn } from "@/lib/cn";
import {
  useTerminalSettings,
  getThemePreset,
  THEME_PRESETS,
} from "./TerminalSettings";

// Import xterm CSS (must be imported in client component)
import "xterm/css/xterm.css";

// Dynamically import xterm types for TypeScript
import type { ITheme, Terminal as TerminalType } from "xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";

interface DirectTerminalProps {
  sessionId: string;
  startFullscreen?: boolean;
  variant?: "agent" | "orchestrator";
  /** CSS height for the terminal container in normal (non-fullscreen) mode. */
  height?: string;
  isOpenCodeSession?: boolean;
  reloadCommand?: string;
  /** Agent name to show in top bar badge (e.g. "Claude Code") */
  agentName?: string;
  /** PR number to show in status bar */
  prNumber?: number;
  /** PR URL to link in status bar */
  prUrl?: string;
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
 */
export function DirectTerminal({
  sessionId,
  startFullscreen = false,
  variant = "agent",
  height = "max(440px, calc(100dvh - 440px))",
  isOpenCodeSession = false,
  reloadCommand,
  agentName,
  prNumber,
  prUrl,
}: DirectTerminalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();
  const terminalThemes = useMemo(() => buildTerminalThemes(variant), [variant]);
  const [settings] = useTerminalSettings();

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

    permanentErrorRef.current = false;
    reconnectAttemptRef.current = 0;

    let mounted = true;
    let cleanup: (() => void) | null = null;
    let inputDisposable: { dispose(): void } | null = null;

    const PERMANENT_CLOSE_CODES = new Set([4001, 4004]);
    const MAX_RECONNECT_DELAY = 15_000;

    Promise.all([
      import("xterm").then((mod) => mod.Terminal),
      import("@xterm/addon-fit").then((mod) => mod.FitAddon),
      import("@xterm/addon-web-links").then((mod) => mod.WebLinksAddon),
      import("@xterm/addon-webgl").then((mod) => mod.WebglAddon).catch(() => null),
      document.fonts.ready,
    ])
      .then(([Terminal, FitAddon, WebLinksAddon, WebglAddon]) => {
        if (!mounted || !terminalRef.current) return;

        const isDark = resolvedTheme !== "light";
        const preset = isDark ? getThemePreset(settings.themeName) : undefined;
        const activeTheme = isDark ? (preset?.dark ?? terminalThemes.dark) : terminalThemes.light;

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

        const fit = new FitAddon();
        terminal.loadAddon(fit);
        fitAddon.current = fit;

        const webLinks = new WebLinksAddon();
        terminal.loadAddon(webLinks);

        terminal.parser.registerCsiHandler(
          { prefix: ">", final: "q" },
          () => {
            terminal.write("\x1bP>|XTerm(370)\x1b\\");
            return true;
          },
        );

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

        terminal.open(terminalRef.current);
        terminalInstance.current = terminal;

        if (WebglAddon) {
          try {
            terminal.loadAddon(new WebglAddon());
          } catch {
            // Canvas fallback
          }
        }

        fit.fit();

        const runtimeConnectionConfig: TerminalConnectionConfig = {};
        let runtimeFetchDone = false;

        const writeBuffer: string[] = [];
        let selectionActive = false;
        let safetyTimer: ReturnType<typeof setTimeout> | null = null;
        let bufferBytes = 0;
        const MAX_BUFFER_BYTES = 1_048_576;

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

        const handleResize = () => {
          const currentWs = ws.current;
          if (fit && currentWs?.readyState === WebSocket.OPEN) {
            fit.fit();
            currentWs.send(
              JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
            );
          }
        };

        window.addEventListener("resize", handleResize);

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
              JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
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
      terminal.options.theme = preset ? preset.dark : terminalThemes.dark;
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
    const currentWs = ws.current;
    if (currentWs?.readyState === WebSocket.OPEN) {
      currentWs.send(
        JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
      );
    }
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
          JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
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
      if (!cancelled) { resizeAttempts = 0; lastHeight = -1; resizeTerminal(); }
    }, 300);
    const timer2 = setTimeout(() => {
      if (!cancelled) { resizeAttempts = 0; lastHeight = -1; resizeTerminal(); }
    }, 600);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      parent?.removeEventListener("transitionend", handleTransitionEnd);
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [fullscreen]);

  // ── Derived state for chrome ─────────────────────────────────────

  const isLight = resolvedTheme === "light";

  const containerBg = useMemo(() => {
    if (isLight) return "#fafafa";
    const preset = getThemePreset(settings.themeName);
    return preset?.dark.background ?? "#0d1117";
  }, [isLight, settings.themeName]);

  // Chrome colors — adapt to light/dark
  const chrome = isLight
    ? {
        barBg: "rgba(246, 248, 250, 0.9)",
        barBorder: "#d1d9e0",
        statusBarBg: "#f0f3f6",
        text: "#1f2328",
        textMuted: "#656d76",
        divider: "#d1d9e0",
        btnBg: "rgba(0,0,0,0.04)",
        btnBorder: "#d1d9e0",
        btnHoverBg: "rgba(0,0,0,0.08)",
        btnText: "#656d76",
        btnHoverText: "#1f2328",
        containerBorder: "#d1d9e0",
        shadow: "0 4px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)",
        permissionColor: "#1a7f37",
        prLinkColor: "#0969da",
        agentBadgeColor: "#8250df",
        agentBadgeBg: "rgba(130,80,223,0.08)",
        agentBadgeBorder: "1px solid rgba(130,80,223,0.2)",
      }
    : {
        barBg: "rgba(22, 27, 34, 0.8)",
        barBorder: "#21262d",
        statusBarBg: "#161b22",
        text: "#e6edf3",
        textMuted: "#8b949e",
        divider: "#484f58",
        btnBg: "rgba(255,255,255,0.06)",
        btnBorder: "#30363d",
        btnHoverBg: "rgba(255,255,255,0.1)",
        btnText: "#8b949e",
        btnHoverText: "#e6edf3",
        containerBorder: "#21262d",
        shadow: "0 8px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)",
        permissionColor: "#3fb950",
        prLinkColor: "#58a6ff",
        agentBadgeColor: "#d2a8ff",
        agentBadgeBg: "rgba(210,168,255,0.1)",
        agentBadgeBorder: "1px solid rgba(210,168,255,0.25)",
      };

  // Top bar (~42px) + status bar (~33px)
  const chromeHeight = "75px";

  // Connection dot
  const dotBg =
    status === "connected" ? "#3fb950" : status === "error" ? "#f85149" : "#d29922";
  const dotShadow =
    status === "connected"
      ? "0 0 8px rgba(63,185,80,0.6)"
      : status === "error"
        ? "0 0 8px rgba(248,81,73,0.5)"
        : "0 0 8px rgba(210,153,34,0.5)";
  const dotAnimation = status === "connected" ? "terminal-dot-pulse 2s ease-in-out infinite" : "none";

  // Badge
  const isReconnecting = status === "connecting" && reconnectAttemptRef.current > 0;
  const badgeText =
    status === "connected"
      ? "CONNECTED"
      : status === "error"
        ? (error ?? "DISCONNECTED")
        : isReconnecting
          ? "RECONNECTING"
          : "CONNECTING";
  const badgeColor =
    status === "connected" ? "#3fb950" : status === "error" ? "#f85149" : "#d29922";
  const badgeBg =
    status === "connected"
      ? "rgba(63,185,80,0.15)"
      : status === "error"
        ? "rgba(248,81,73,0.15)"
        : "rgba(210,153,34,0.15)";
  const badgeBorder =
    status === "connected"
      ? "1px solid rgba(63,185,80,0.3)"
      : status === "error"
        ? "1px solid rgba(248,81,73,0.3)"
        : "1px solid rgba(210,153,34,0.3)";

  return (
    <div
      className={cn(
        "terminal-container border",
        fullscreen ? "fixed inset-0 z-50 overflow-hidden rounded-none border-0" : "overflow-x-hidden",
      )}
      style={{
        background: containerBg,
        borderColor: chrome.containerBorder,
        borderRadius: fullscreen ? 0 : 12,
        boxShadow: fullscreen ? "none" : chrome.shadow,
      }}
    >
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div
        className="topbar flex items-center justify-between"
        style={{
          padding: "10px 16px",
          background: chrome.barBg,
          borderBottom: `1px solid ${chrome.barBorder}`,
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        {/* Left side */}
        <div className="topbar-left flex items-center" style={{ gap: 10 }}>
          {/* Connection dot */}
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: dotBg,
              boxShadow: dotShadow,
              animation: dotAnimation,
              flexShrink: 0,
            }}
          />
          {/* Session name */}
          <span
            style={{
              fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
              fontSize: 13,
              fontWeight: 600,
              color: chrome.text,
            }}
          >
            {sessionId}
          </span>
          {/* Connection badge */}
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 10,
              color: badgeColor,
              background: badgeBg,
              border: badgeBorder,
              lineHeight: "16px",
            }}
          >
            {badgeText}
          </span>
          {/* Agent type badge */}
          {agentName ? (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 10,
                color: chrome.agentBadgeColor,
                background: chrome.agentBadgeBg,
                border: chrome.agentBadgeBorder,
                lineHeight: "16px",
              }}
            >
              {agentName}
            </span>
          ) : null}
          {/* OpenCode reload button */}
          {isOpenCodeSession ? (
            <button
              onClick={handleReload}
              disabled={reloading || status !== "connected"}
              title="Restart OpenCode session"
              aria-label="Restart OpenCode session"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 10px",
                background: chrome.btnBg,
                border: `1px solid ${chrome.btnBorder}`,
                borderRadius: 6,
                color: chrome.btnText,
                fontSize: 12,
                cursor: reloading ? "not-allowed" : "pointer",
                opacity: reloading ? 0.6 : 1,
              }}
            >
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                {reloading ? <path d="M12 3a9 9 0 109 9" /> : <><path d="M21 12a9 9 0 11-2.64-6.36" /><path d="M21 3v6h-6" /></>}
              </svg>
            </button>
          ) : null}
          {reloadError ? (
            <span style={{ fontSize: 10, color: "#f85149", maxWidth: "30ch", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {reloadError}
            </span>
          ) : null}
        </div>

        {/* Right side */}
        <div className="topbar-right flex items-center" style={{ gap: 8 }}>
          <button
            onClick={() => setFullscreen(!fullscreen)}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="terminal-topbar-btn"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              background: chrome.btnBg,
              border: `1px solid ${chrome.btnBorder}`,
              borderRadius: 6,
              color: chrome.btnText,
              fontSize: 12,
              cursor: "pointer",
            }}
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
            <span className="hidden sm:inline">{fullscreen ? "exit fullscreen" : "fullscreen"}</span>
          </button>
        </div>
      </div>

      {/* ── Terminal area ───────────────────────────────────────────── */}
      {/* Outer wrapper provides visual padding; the xterm mount target
          must have zero padding so FitAddon measures the full width. */}
      <div
        style={{
          padding: "8px 16px",
          height: fullscreen ? `calc(100dvh - ${chromeHeight})` : height,
          overflow: "hidden",
        }}
      >
        <div
          ref={terminalRef}
          style={{
            /* Slightly narrower than parent so FitAddon calculates cols
               with a small buffer — prevents sub-pixel rounding from
               making the canvas 1-2px wider than the visible area. */
            width: "calc(100% - 4px)",
            margin: "0 auto",
            height: "100%",
            overflow: "hidden",
          }}
        />
      </div>

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: "6px 16px",
          background: chrome.statusBarBg,
          borderTop: `1px solid ${chrome.barBorder}`,
          fontSize: 11,
        }}
      >
        {/* Left side */}
        <div className="flex items-center" style={{ gap: 12, color: chrome.textMuted }}>
          {/* Permission badge — Claude Code specific */}
          {agentName === "Claude Code" ? (
            <>
              <span style={{ color: chrome.permissionColor, fontWeight: 600, fontFamily: '"JetBrains Mono", monospace' }}>
                <svg
                  className="mr-1 inline-block"
                  width="12" height="12" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5"
                >
                  <path d="M7 17l9.2-9.2M17 17V7H7" />
                </svg>
                bypass permissions on
              </span>
              <span style={{ color: chrome.divider }}>|</span>
              <span className="hidden sm:inline">(shift+tab to cycle)</span>
            </>
          ) : agentName ? (
            <span style={{ color: chrome.textMuted, fontFamily: '"JetBrains Mono", monospace' }}>
              {agentName}
            </span>
          ) : null}
          {prNumber ? (
            <>
              <span className="hidden sm:inline" style={{ color: chrome.divider }}>|</span>
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: chrome.prLinkColor,
                  fontFamily: '"JetBrains Mono", monospace',
                  fontWeight: 500,
                  textDecoration: "none",
                }}
                className="hover:underline"
              >
                PR #{prNumber}
              </a>
            </>
          ) : null}
        </div>

        {/* Right side — reserved for cost display */}
        <div />
      </div>
    </div>
  );
}
