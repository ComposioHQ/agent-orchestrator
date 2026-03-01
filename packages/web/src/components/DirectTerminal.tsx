"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";

// Import xterm CSS (must be imported in client component)
import "xterm/css/xterm.css";

// Dynamically import xterm types for TypeScript
import type { Terminal as TerminalType } from "xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";

interface DirectTerminalProps {
  sessionId: string;
  startFullscreen?: boolean;
  /** Visual variant. "orchestrator" uses violet accent; "agent" (default) uses blue. */
  variant?: "agent" | "orchestrator";
  /** CSS height for the terminal container in normal (non-fullscreen) mode.
   *  Defaults to "max(440px, calc(100vh - 440px))". */
  height?: string;
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
    ])
      .then(([Terminal, FitAddon, WebLinksAddon]) => {
        if (!mounted || !terminalRef.current) return;

        // Cursor and selection color differ by variant:
        // agent = blue (#5b7ef8), orchestrator = violet (#a371f7)
        const cursorColor = variant === "orchestrator" ? "#a371f7" : "#5b7ef8";
        const selectionColor =
          variant === "orchestrator"
            ? "rgba(163, 113, 247, 0.25)"
            : "rgba(91, 126, 248, 0.3)";

        // Initialize xterm.js Terminal
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
            black:         "#1a1a24",
            red:           "#ef4444",
            green:         "#22c55e",
            yellow:        "#f59e0b",
            blue:          "#5b7ef8",
            magenta:       "#a371f7",
            cyan:          "#22d3ee",
            white:         "#d4d4d8",
            brightBlack:   "#50506a",
            brightRed:     "#f87171",
            brightGreen:   "#4ade80",
            brightYellow:  "#fbbf24",
            brightBlue:    "#7b9cfb",
            brightMagenta: "#c084fc",
            brightCyan:    "#67e8f9",
            brightWhite:   "#eeeef5",
          },
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

        // WebSocket URL (stable across reconnects)
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const hostname = window.location.hostname;
        const port = process.env.NEXT_PUBLIC_DIRECT_TERMINAL_PORT ?? "14801";
        const wsUrl = `${protocol}//${hostname}:${port}/ws?session=${encodeURIComponent(sessionId)}`;

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
          if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
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

        // Intercept Cmd+C/V (Mac) and Ctrl+Shift+C/V (Linux/Win) for clipboard.
        // Cmd+C is kept as a fallback (selection may still be alive).
        // Cmd+V intercepts the key so xterm doesn't process it; the actual
        // paste is handled by the DOM "paste" event listener below.
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

          // Cmd+V / Ctrl+Shift+V — trigger native paste event
          const isPaste =
            (e.metaKey && !e.ctrlKey && !e.altKey && e.code === "KeyV") ||
            (e.ctrlKey && e.shiftKey && e.code === "KeyV");
          if (isPaste) {
            // Let the browser fire the "paste" event (handled below).
            // Returning true allows the event to propagate normally.
            return true;
          }

          return true;
        });

        // Handle paste via the DOM "paste" event — this provides clipboard
        // content through ClipboardEvent.clipboardData without needing the
        // Clipboard API "clipboard-read" permission.
        const termEl = terminalRef.current!;
        const handlePaste = (e: ClipboardEvent) => {
          const text = e.clipboardData?.getData("text/plain");
          if (text) {
            e.preventDefault();
            terminal.paste(text);
          }
        };
        termEl.addEventListener("paste", handlePaste);

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
          termEl.removeEventListener("paste", handlePaste as EventListener);
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

  const accentColor = variant === "orchestrator" ? "var(--color-accent-violet)" : "var(--color-accent)";

  const statusDotClass =
    status === "connected"
      ? "bg-[var(--color-status-ready)]"
      : status === "error"
        ? "bg-[var(--color-status-error)]"
        : "bg-[var(--color-status-attention)] animate-[pulse_1.5s_ease-in-out_infinite]";

  const statusText =
    status === "connected"
      ? "Connected"
      : status === "error"
        ? (error ?? "Error")
        : "Connecting…";

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
        <span
          className="font-[var(--font-mono)] text-[11px]"
          style={{ color: accentColor }}
        >
          {sessionId}
        </span>
        <span className={cn("text-[10px] font-medium uppercase tracking-[0.06em]", statusTextColor)}>
          {statusText}
        </span>
        {/* XDA clipboard badge */}
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]"
          style={{
            color: accentColor,
            background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
          }}
        >
          XDA
        </span>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]"
        >
          {fullscreen ? (
            <>
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              </svg>
              exit fullscreen
            </>
          ) : (
            <>
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
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
