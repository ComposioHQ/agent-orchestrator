"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { cn } from "@/lib/cn";
import {
  useTerminalSettings,
  getThemePreset,
  THEME_PRESETS,
  FONT_FAMILIES,
  SELECTION_COLORS,
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

export function buildTerminalThemes(_variant: TerminalVariant): { dark: ITheme; light: ITheme } {
  const accent = {
    cursor: "#58a6ff",
    selDark: "rgba(88, 166, 255, 0.3)",
    selLight: "rgba(91, 126, 248, 0.25)",
  };

  const githubDark = getThemePreset("github-dark")?.dark ?? THEME_PRESETS[0].dark;
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
  const [settings, updateSettings] = useTerminalSettings();

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
  const [showSettings, setShowSettings] = useState(false);
  const [panelPos, setPanelPos] = useState({ top: 0, right: 0 });
  const [reconnectCount, setReconnectCount] = useState(0);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  const isLight = resolvedTheme === "light";

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

  // Position the settings panel below the gear button
  useEffect(() => {
    if (showSettings && settingsButtonRef.current) {
      const rect = settingsButtonRef.current.getBoundingClientRect();
      setPanelPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
  }, [showSettings]);

  // Close settings panel on click outside or scroll
  useEffect(() => {
    if (!showSettings) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        settingsPanelRef.current && !settingsPanelRef.current.contains(target) &&
        settingsButtonRef.current && !settingsButtonRef.current.contains(target)
      ) {
        setShowSettings(false);
      }
    }
    function handleScroll() {
      setShowSettings(false);
    }
    document.addEventListener("mousedown", handleClick);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [showSettings]);

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
        const baseTheme = isDark
          ? (getThemePreset(settings.themeName)?.dark ?? terminalThemes.dark)
          : terminalThemes.light;
        const activeTheme = { ...baseTheme, selectionBackground: settings.selectionColor };

        const terminal = new Terminal({
          cursorBlink: settings.cursorBlink,
          fontSize: settings.fontSize,
          cursorStyle: settings.cursorStyle,
          fontFamily: settings.fontFamily,
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

        // Defer initial fit so the browser finalizes DOM layout first
        requestAnimationFrame(() => fit.fit());

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

        // ResizeObserver catches both window resizes and container-only
        // resizes (sidebar toggle, panel open/close, etc.)
        const resizeObserver = new ResizeObserver(() => {
          const currentWs = ws.current;
          if (fit && currentWs?.readyState === WebSocket.OPEN) {
            fit.fit();
            currentWs.send(
              JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
            );
          }
        });
        resizeObserver.observe(terminalRef.current);

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
            setReconnectCount(0);
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
            setReconnectCount(attempt + 1);
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
  }, [sessionId, variant]);

  // Apply theme — light mode uses light theme, dark mode uses selected preset
  useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal) return;
    if (isLight) {
      terminal.options.theme = { ...terminalThemes.light, selectionBackground: settings.selectionColor };
      terminal.options.minimumContrastRatio = 7;
    } else {
      const preset = getThemePreset(settings.themeName);
      const baseTheme = preset ? preset.dark : terminalThemes.dark;
      terminal.options.theme = { ...baseTheme, selectionBackground: settings.selectionColor };
      terminal.options.minimumContrastRatio = 1;
    }
  }, [isLight, terminalThemes, settings.themeName, settings.selectionColor]);

  // Apply font/cursor setting changes live
  useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal) return;
    terminal.options.fontSize = settings.fontSize;
    terminal.options.fontFamily = settings.fontFamily;
    terminal.options.cursorStyle = settings.cursorStyle;
    terminal.options.cursorBlink = settings.cursorBlink;
    // Force xterm to re-render with new cursor settings
    terminal.refresh(0, terminal.rows - 1);
    fitAddon.current?.fit();
    const currentWs = ws.current;
    if (currentWs?.readyState === WebSocket.OPEN) {
      currentWs.send(
        JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }),
      );
    }
  }, [settings.fontSize, settings.fontFamily, settings.cursorStyle, settings.cursorBlink]);

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
        btnBg: "rgba(0,0,0,0.04)",
        btnBorder: "#d1d9e0",
        btnText: "#656d76",
        containerBorder: "#d1d9e0",
        shadow: "0 4px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)",
        prLinkColor: "#0969da",
        agentBadgeColor: "#8250df",
        agentBadgeBg: "rgba(130,80,223,0.08)",
        agentBadgeBorder: "1px solid rgba(130,80,223,0.2)",
        accent: "#0969da",
        accentText: "#fff",
        panelBg: "#ffffff",
        panelShadow: "0 8px 24px rgba(0,0,0,0.12)",
      }
    : {
        barBg: "rgba(22, 27, 34, 0.8)",
        barBorder: "#21262d",
        statusBarBg: "#161b22",
        text: "#e6edf3",
        textMuted: "#8b949e",
        btnBg: "rgba(255,255,255,0.06)",
        btnBorder: "#30363d",
        btnText: "#8b949e",
        containerBorder: "#21262d",
        shadow: "0 8px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)",
        prLinkColor: "#58a6ff",
        agentBadgeColor: "#d2a8ff",
        agentBadgeBg: "rgba(210,168,255,0.1)",
        agentBadgeBorder: "1px solid rgba(210,168,255,0.25)",
        accent: "#58a6ff",
        accentText: "#fff",
        panelBg: "#161b22",
        panelShadow: "0 8px 24px rgba(0,0,0,0.3)",
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
  const isReconnecting = status === "connecting" && reconnectCount > 0;
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
        fullscreen ? "fixed inset-0 z-50 overflow-hidden rounded-none border-0" : "overflow-hidden",
      )}
      style={{
        background: containerBg,
        borderColor: chrome.containerBorder,
        borderRadius: fullscreen ? 0 : 12,
        boxShadow: fullscreen ? "none" : chrome.shadow,
      }}
    >
      {/* ── Top bar — z-index above terminal area so settings panel isn't clipped */}
      <div
        className="topbar flex items-center justify-between"
        style={{
          position: "relative",
          zIndex: 10,
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
          {/* Settings button */}
          <div className="relative">
            <button
              ref={settingsButtonRef}
              onClick={() => setShowSettings((v) => !v)}
              title="Terminal settings"
              aria-label="Terminal settings"
              className="terminal-topbar-btn"
              style={{
                display: "flex",
                alignItems: "center",
                padding: "4px 8px",
                background: showSettings ? chrome.btnBg : "transparent",
                border: `1px solid ${showSettings ? chrome.btnBorder : "transparent"}`,
                borderRadius: 6,
                color: chrome.btnText,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            {/* Settings panel — rendered via portal to avoid overflow clipping */}
            {showSettings ? createPortal(
              <div
                ref={settingsPanelRef}
                style={{
                  position: "fixed",
                  top: panelPos.top,
                  right: panelPos.right,
                  width: 300,
                  background: isLight ? chrome.panelBg : "#161b22",
                  border: `1px solid ${isLight ? chrome.barBorder : "#30363d"}`,
                  borderRadius: 12,
                  boxShadow: isLight ? "0 8px 24px rgba(0,0,0,0.12)" : "0 16px 48px rgba(0,0,0,0.5)",
                  padding: 16,
                  zIndex: 9999,
                  fontSize: 12,
                }}
              >
                {/* Title */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: chrome.text, marginBottom: 16 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={chrome.textMuted} strokeWidth="2">
                    <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  Terminal Settings
                </div>

                {/* Font Family */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: chrome.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", fontWeight: 500, marginBottom: 6 }}>Font Family</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {FONT_FAMILIES.map((f) => {
                      const active = settings.fontFamily === f.value;
                      return (
                        <button key={f.value} onClick={() => updateSettings({ fontFamily: f.value })} style={{
                          fontSize: 12, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                          fontFamily: '"JetBrains Mono", monospace',
                          border: `1px solid ${active ? chrome.accent : (isLight ? "#d1d9e0" : "#30363d")}`,
                          background: active ? `color-mix(in srgb, ${chrome.accent} 10%, transparent)` : (isLight ? "rgba(0,0,0,0.02)" : "rgba(255,255,255,0.03)"),
                          color: active ? chrome.accent : chrome.textMuted,
                        }}>{f.label}</button>
                      );
                    })}
                  </div>
                </div>

                {/* Font Size */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: chrome.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", fontWeight: 500, marginBottom: 6 }}>Font Size</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[12, 13, 14, 15, 16].map((size) => {
                      const active = settings.fontSize === size;
                      return (
                        <button key={size} onClick={() => updateSettings({ fontSize: size })} style={{
                          fontSize: 12, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                          fontFamily: '"JetBrains Mono", monospace',
                          border: `1px solid ${active ? chrome.accent : (isLight ? "#d1d9e0" : "#30363d")}`,
                          background: active ? `color-mix(in srgb, ${chrome.accent} 10%, transparent)` : (isLight ? "rgba(0,0,0,0.02)" : "rgba(255,255,255,0.03)"),
                          color: active ? chrome.accent : chrome.textMuted,
                        }}>{size}px</button>
                      );
                    })}
                  </div>
                </div>

                {/* Divider */}
                <div style={{ height: 1, background: isLight ? "#d8dee4" : "#21262d", margin: "14px 0" }} />

                {/* Theme — only active in dark mode */}
                <div style={{ marginBottom: 14, opacity: isLight ? 0.5 : 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: chrome.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", fontWeight: 500 }}>Theme</span>
                    {isLight ? <span style={{ fontSize: 10, color: chrome.textMuted, fontStyle: "italic" }}>(dark mode only)</span> : null}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {THEME_PRESETS.map((preset) => (
                      <button
                        key={preset.name}
                        onClick={() => updateSettings({ themeName: preset.name })}
                        title={preset.label}
                        disabled={isLight}
                        style={{
                          width: 28, height: 28, borderRadius: 8, background: preset.swatch, padding: 0,
                          cursor: isLight ? "default" : "pointer",
                          border: settings.themeName === preset.name ? `2px solid ${chrome.accent}` : `2px solid ${isLight ? "#d1d9e0" : "transparent"}`,
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* Cursor Style — icons with text labels */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: chrome.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", fontWeight: 500, marginBottom: 6 }}>Cursor Style</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {(["block", "bar", "underline"] as const).map((style) => {
                      const active = settings.cursorStyle === style;
                      const label = style.charAt(0).toUpperCase() + style.slice(1);
                      return (
                        <button key={style} onClick={() => updateSettings({ cursorStyle: style })} title={label} style={{
                          display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
                          fontSize: 12, fontFamily: '"JetBrains Mono", monospace',
                          border: `1px solid ${active ? chrome.accent : (isLight ? "#d1d9e0" : "#30363d")}`,
                          background: active ? `color-mix(in srgb, ${chrome.accent} 10%, transparent)` : (isLight ? "rgba(0,0,0,0.02)" : "rgba(255,255,255,0.03)"),
                          color: active ? chrome.accent : chrome.textMuted,
                        }}>
                          {style === "block" ? (
                            <div style={{ width: 8, height: 14, background: active ? chrome.accent : chrome.textMuted, borderRadius: 1 }} />
                          ) : style === "bar" ? (
                            <div style={{ width: 2, height: 14, background: active ? chrome.accent : chrome.textMuted, borderRadius: 1 }} />
                          ) : (
                            <div style={{ width: 8, height: 2, background: active ? chrome.accent : chrome.textMuted, borderRadius: 1 }} />
                          )}
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Cursor Blink */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <span style={{ fontSize: 12, color: chrome.textMuted }}>Cursor Blink</span>
                  <button
                    onClick={() => updateSettings({ cursorBlink: !settings.cursorBlink })}
                    style={{
                      width: 40, height: 22, borderRadius: 11, position: "relative", cursor: "pointer", padding: 0,
                      background: settings.cursorBlink ? chrome.accent : (isLight ? "#d1d9e0" : "#484f58"),
                      border: "none", transition: "background 0.15s ease",
                    }}
                  >
                    <div style={{
                      width: 16, height: 16, borderRadius: "50%", background: "#fff", position: "absolute", top: 3,
                      left: settings.cursorBlink ? 21 : 3, transition: "left 0.15s ease",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                    }} />
                  </button>
                </div>

                {/* Selection Color */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: chrome.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", fontWeight: 500, marginBottom: 6 }}>Selection Color</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {SELECTION_COLORS.map((color) => (
                      <button key={color.value} onClick={() => updateSettings({ selectionColor: color.value })} title={color.label} style={{
                        width: 28, height: 28, borderRadius: 8, background: color.swatch, cursor: "pointer", padding: 0,
                        border: settings.selectionColor === color.value ? `2px solid ${chrome.accent}` : "2px solid transparent",
                        opacity: settings.selectionColor === color.value ? 1 : 0.7,
                      }} />
                    ))}
                  </div>
                </div>

                {/* Reset to Defaults */}
                <button
                  onClick={() => updateSettings({
                    fontSize: 14,
                    fontFamily: '"JetBrains Mono", monospace',
                    cursorStyle: "bar",
                    cursorBlink: true,
                    selectionColor: "rgba(88,166,255,0.3)",
                    themeName: "github-dark",
                  })}
                  style={{
                    width: "100%", padding: "6px 0", borderRadius: 6, cursor: "pointer",
                    fontSize: 12, fontWeight: 500, color: chrome.textMuted,
                    background: isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${isLight ? "#d1d9e0" : "#30363d"}`,
                  }}
                >
                  Reset to Defaults
                </button>
              </div>,
              document.body,
            ) : null}
          </div>
          {/* Fullscreen button */}
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

      {/* Outer padding wrapper — provides visual spacing around the terminal.
          FitAddon reads width from terminalRef (parentElement of .xterm),
          so terminalRef must have NO padding. The outer wrapper's padding
          reduces the available width BEFORE FitAddon measures it. */}
      <div className="p-1.5">
        <div
          ref={terminalRef}
          style={{
            height: fullscreen ? `calc(100dvh - ${chromeHeight} - 12px)` : `calc(${height} - 12px)`,
            overflow: "hidden",
          }}
        />
      </div>

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: "5px 16px",
          background: chrome.statusBarBg,
          borderTop: `1px solid ${chrome.barBorder}`,
          fontSize: 11,
        }}
      >
        {/* Left — font info */}
        <span style={{ color: chrome.textMuted, fontFamily: '"JetBrains Mono", monospace' }}>
          {FONT_FAMILIES.find((f) => f.value === settings.fontFamily)?.label ?? "monospace"}
          {" · "}
          {settings.fontSize}px
        </span>
        {/* Right — PR link if available */}
        {prNumber ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: chrome.prLinkColor,
              fontFamily: '"JetBrains Mono", monospace',
              fontWeight: 500,
              fontSize: 11,
              textDecoration: "none",
            }}
            className="hover:underline"
          >
            PR #{prNumber}
          </a>
        ) : <div />}
      </div>
    </div>
  );
}
