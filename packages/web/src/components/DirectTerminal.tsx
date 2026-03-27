"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { cn } from "@/lib/cn";

function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

const SCROLLBAR_WIDTH = 5; // matches .xterm-viewport::-webkit-scrollbar { width: 5px }
const FONT_SIZE_KEY = "ao:web:terminal-font-size";
const FONT_SIZE_MIN = 9;
const FONT_SIZE_MAX = 18;
const FONT_SIZE_DEFAULT = 13;

function getStoredFontSize(): number {
  if (typeof window === "undefined") return FONT_SIZE_DEFAULT;
  const stored = localStorage.getItem(FONT_SIZE_KEY);
  if (!stored) return FONT_SIZE_DEFAULT;
  const n = parseInt(stored, 10);
  return Number.isFinite(n) && n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX ? n : FONT_SIZE_DEFAULT;
}

/** Wrapper around FitAddon.fit() that verifies the measurement using
 *  getBoundingClientRect (immune to content-inflated getComputedStyle).
 *  Falls back to FitAddon first, then corrects if cols/rows are wrong. */
function fitTerminal(
  fit: FitAddonType,
  terminal: TerminalType,
  containerEl: HTMLElement,
) {
  fit.fit();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = (terminal as any)._core;
  const cellWidth: number | undefined = core?._renderService?.dimensions?.css?.cell?.width;
  const cellHeight: number | undefined = core?._renderService?.dimensions?.css?.cell?.height;
  if (!cellWidth || !cellHeight) return;

  const rect = containerEl.getBoundingClientRect();
  const xtermEl = terminal.element;
  if (!xtermEl) return;

  const style = window.getComputedStyle(xtermEl);
  const paddingX = parseInt(style.paddingLeft || "0") + parseInt(style.paddingRight || "0");
  const paddingY = parseInt(style.paddingTop || "0") + parseInt(style.paddingBottom || "0");
  const sbWidth = terminal.options.scrollback === 0 ? 0 : SCROLLBAR_WIDTH;

  const correctCols = Math.max(2, Math.floor((rect.width - paddingX - sbWidth) / cellWidth));
  const correctRows = Math.max(1, Math.floor((rect.height - paddingY) / cellHeight));

  if (terminal.cols !== correctCols || terminal.rows !== correctRows) {
    core._renderService?.clear();
    terminal.resize(correctCols, correctRows);
  }
}

// Import xterm CSS (must be imported in client component)
import "@xterm/xterm/css/xterm.css";

// Dynamically import xterm types for TypeScript
import type { ITheme, Terminal as TerminalType } from "@xterm/xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";

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
  /** When set, renders a pane-header-style label at the start of the chrome bar,
   *  merging the label bar and chrome bar into a single row. */
  headerLabel?: string;
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

type TerminalVariant = "agent" | "orchestrator";

export function buildTerminalThemes(variant: TerminalVariant): { dark: ITheme; light: ITheme } {
  const agentAccent = {
    cursor: "#5b7ef8",
    selDark: "rgba(91, 126, 248, 0.30)",
    selLight: "rgba(91, 126, 248, 0.25)",
  };
  const orchAccent = {
    cursor: "#a371f7",
    selDark: "rgba(163, 113, 247, 0.25)",
    selLight: "rgba(130, 80, 223, 0.20)",
  };
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
  height = "max(440px, calc(100vh - 440px))",
  isOpenCodeSession = false,
  reloadCommand,
  headerLabel,
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
  const [followOutput, setFollowOutput] = useState(true);
  const followOutputRef = useRef(true);
  const [fontSize, setFontSize] = useState(FONT_SIZE_DEFAULT);
  const [showFontSettings, setShowFontSettings] = useState(false);
  const fontSettingsRef = useRef<HTMLDivElement>(null);

  // Hydrate font size from localStorage
  useEffect(() => {
    setFontSize(getStoredFontSize());
  }, []);

  // Close font settings popover on outside click
  useEffect(() => {
    if (!showFontSettings) return;
    function handleClick(e: MouseEvent) {
      if (fontSettingsRef.current && !fontSettingsRef.current.contains(e.target as Node)) {
        setShowFontSettings(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showFontSettings]);

  const handleFontSizeChange = useCallback((newSize: number) => {
    const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, newSize));
    setFontSize(clamped);
    localStorage.setItem(FONT_SIZE_KEY, String(clamped));
    const terminal = terminalInstance.current;
    const fit = fitAddon.current;
    if (terminal) {
      terminal.options.fontSize = clamped;
      if (fit && terminalRef.current) {
        fitTerminal(fit, terminal, terminalRef.current);
      }
    }
  }, []);

  useEffect(() => {
    followOutputRef.current = followOutput;
  }, [followOutput]);

  // Touch scroll: attach to terminalRef (parent of .xterm) so xterm can't
  // kill the gesture. CSS `touch-action: none` on .xterm-screen prevents
  // the browser from consuming the touch sequence.
  useEffect(() => {
    const container = terminalRef.current;
    if (!container || !isTouchDevice()) return;

    let startY = 0;
    let startX = 0;
    let accumulator = 0;
    let decided = false;
    let isVertical = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      accumulator = 0;
      decided = false;
      isVertical = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const terminal = terminalInstance.current;
      if (!terminal) return;

      const currentY = e.touches[0].clientY;
      const currentX = e.touches[0].clientX;

      if (!decided) {
        const dx = Math.abs(currentX - startX);
        const dy = Math.abs(currentY - startY);
        if (dy < 5 && dx < 5) return;
        decided = true;
        isVertical = dy > dx;
      }

      if (!isVertical) return;

      const deltaY = startY - currentY;
      startY = currentY;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cellHeight = (terminal as any)._core?._renderService?.dimensions?.css?.cell?.height || 15;
      accumulator += deltaY / cellHeight;

      const lines = Math.trunc(accumulator);
      if (lines !== 0) {
        terminal.scrollLines(lines);
        accumulator -= lines;
      }
      e.preventDefault();
    };

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

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

    const PERMANENT_CLOSE_CODES = new Set([4001, 4004]); // auth failure, session not found
    const MAX_RECONNECT_DELAY = 15_000;

    Promise.all([
      import("@xterm/xterm").then((mod) => mod.Terminal),
      import("@xterm/addon-fit").then((mod) => mod.FitAddon),
      import("@xterm/addon-web-links").then((mod) => mod.WebLinksAddon),
      document.fonts.ready,
    ])
      .then(([Terminal, FitAddon, WebLinksAddon]) => {
        if (!mounted || !terminalRef.current) return;

        const isDark = resolvedTheme !== "light";
        const activeTheme = isDark ? terminalThemes.dark : terminalThemes.light;

        // Initialize xterm.js Terminal
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: getStoredFontSize(),
          theme: activeTheme,
          // Light mode needs an explicit contrast floor because agent UIs often emit
          // dim/faint ANSI sequences that become unreadable on a near-white background.
          minimumContrastRatio: isDark ? 1 : 7,
          scrollback: 10000,
          allowProposedApi: true,
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
        const viewport = terminal.element?.querySelector(".xterm-viewport") as HTMLElement | null;
        if (viewport) {
          viewport.style.touchAction = "pan-y";
          viewport.style.setProperty("-webkit-overflow-scrolling", "touch");
        }

        // Touch scrolling is handled via a transparent overlay div (see render).
        // xterm's own pointer handlers kill touch gestures after 1 event,
        // so event listeners on xterm elements don't work reliably.

        // Fit terminal to container
        fitTerminal(fit, terminal, terminalRef.current);
        // Re-verify after layout settles (grid may not be final yet)
        requestAnimationFrame(() => {
          if (mounted && terminalRef.current) {
            fitTerminal(fit, terminal, terminalRef.current);
          }
        });

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

        const handleViewportScroll = () => {
          if (!viewport) return;
          const nearBottom =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
          if (nearBottom) {
            setFollowOutput(true);
          } else {
            setFollowOutput(false);
          }
        };
        viewport?.addEventListener("scroll", handleViewportScroll, { passive: true });

        // Handle window resize (works with whatever ws is current)
        const handleResize = () => {
          const currentWs = ws.current;
          if (fit && terminalRef.current) {
            fitTerminal(fit, terminal, terminalRef.current);
            if (currentWs?.readyState === WebSocket.OPEN) {
              currentWs.send(
                JSON.stringify({
                  type: "resize",
                  cols: terminal.cols,
                  rows: terminal.rows,
                }),
              );
            }
          }
        };

        window.addEventListener("resize", handleResize);

        // Watch for container size changes (e.g. resizable pane dividers)
        let resizeObserver: ResizeObserver | undefined;
        let resizeRafId = 0;
        if (terminalRef.current) {
          resizeObserver = new ResizeObserver(() => {
            cancelAnimationFrame(resizeRafId);
            resizeRafId = requestAnimationFrame(() => handleResize());
          });
          resizeObserver.observe(terminalRef.current);
        }

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
              if (followOutputRef.current && viewport) {
                viewport.scrollTop = viewport.scrollHeight;
              }
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
          cancelAnimationFrame(resizeRafId);
          resizeObserver?.disconnect();
          viewport?.removeEventListener("scroll", handleViewportScroll);
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

  // Live theme switching without terminal recreation
  useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal) return;
    const isDark = resolvedTheme !== "light";
    terminal.options.theme = isDark ? terminalThemes.dark : terminalThemes.light;
    terminal.options.minimumContrastRatio = isDark ? 1 : 7;
  }, [resolvedTheme, terminalThemes]);

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
      if (container) fitTerminal(fit, terminal, container);
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
        "flex flex-col overflow-hidden",
        !headerLabel && "border border-[var(--color-border-default)]",
        resolvedTheme === "light" ? "bg-[#fafafa]" : "bg-[#0a0a0f]",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
      style={{ height: fullscreen ? "100vh" : height }}
    >
      {/* Terminal chrome bar */}
      <div className={cn(
        "flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3",
        headerLabel ? "bg-[var(--color-bg-surface)] py-0" : "bg-[var(--color-bg-elevated)] py-2",
      )} style={headerLabel ? { minHeight: "32px" } : undefined}>
        {headerLabel && (
          <span style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--color-text-tertiary)" }}>
            {headerLabel}
          </span>
        )}
        <div className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass)} />
        <span className="font-[var(--font-mono)] text-[11px]" style={{ color: accentColor }}>
          {sessionId}
        </span>
        <span
          className={cn("text-[10px] font-medium uppercase tracking-[0.06em]", statusTextColor)}
        >
          {statusText}
        </span>
        {/* XDA clipboard badge */}
        <span
          className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]"
          style={{
            color: accentColor,
            background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
          }}
        >
          XDA
        </span>
        {isOpenCodeSession ? (
          <button
            onClick={handleReload}
            disabled={reloading || status !== "connected"}
            title="Restart OpenCode session (/exit then resume mapped session)"
            aria-label="Restart OpenCode session"
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
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
        {/* Spacer to push settings & fullscreen to far right */}
        <div className="flex-1" />
        {/* Font size settings */}
        <div ref={fontSettingsRef} className="relative">
          <button
            onClick={() => setShowFontSettings(!showFontSettings)}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]"
            title="Terminal font size"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          {showFontSettings && (
            <div className="absolute right-0 top-full z-50 mt-1 flex items-center gap-2 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 shadow-lg">
              <span className="whitespace-nowrap text-[10px] font-medium text-[var(--color-text-tertiary)]">Font</span>
              <input
                type="range"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={1}
                value={fontSize}
                onChange={(e) => handleFontSizeChange(parseInt(e.target.value, 10))}
                className="h-1 w-24 cursor-pointer accent-[var(--color-accent)]"
              />
              <span className="min-w-[2ch] text-center font-mono text-[11px] font-semibold text-[var(--color-text-secondary)]">
                {fontSize}
              </span>
            </div>
          )}
        </div>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]"
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
      <div className="relative flex-1" style={{ minHeight: 0 }}>
        {!followOutput ? (
          <button
            type="button"
            onClick={() => {
              const viewport = terminalInstance.current?.element?.querySelector(
                ".xterm-viewport",
              ) as HTMLElement | null;
              if (viewport) viewport.scrollTop = viewport.scrollHeight;
              setFollowOutput(true);
            }}
            className="absolute bottom-2 right-2 z-20 border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-3 py-2 text-[12px] text-[var(--color-text-primary)] shadow-sm"
          >
            Jump to latest ↓
          </button>
        ) : null}
        <div
          ref={terminalRef}
          className={cn("w-full")}
          style={{
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            height: "100%",
          }}
        />
      </div>
    </div>
  );
}
