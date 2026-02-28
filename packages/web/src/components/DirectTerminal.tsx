"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";

import "xterm/css/xterm.css";

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
 * Copy support:
 * - Buffers incoming writes while mouse is down so xterm selection isn't
 *   destroyed mid-drag. On mouseup the selection is auto-copied to clipboard
 *   and buffered output is flushed.
 * - Cmd+C / Ctrl+Shift+C copies selection via navigator.clipboard.
 * - Cmd+V / Ctrl+Shift+V pastes from clipboard into the PTY.
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
  const [fullscreen, setFullscreen] = useState(startFullscreen);
  const [status, setStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [copyMode, setCopyMode] = useState(false);
  const [snapshot, setSnapshot] = useState("");
  const [copied, setCopied] = useState(false);

  const takeSnapshot = useCallback(() => {
    const terminal = terminalInstance.current;
    if (!terminal) return "";
    const buf = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  }, []);

  const enterCopyMode = useCallback(() => {
    setSnapshot(takeSnapshot());
    setCopyMode(true);
    setCopied(false);
  }, [takeSnapshot]);

  const exitCopyMode = useCallback(() => {
    setCopyMode(false);
    setSnapshot("");
    setCopied(false);
    terminalInstance.current?.focus();
  }, []);

  const copyAll = useCallback(() => {
    if (!snapshot) return;
    void navigator.clipboard.writeText(snapshot).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [snapshot]);

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
    if (error && status === "error") return;

    let mounted = true;
    let cleanup: (() => void) | null = null;

    Promise.all([
      import("xterm").then((mod) => mod.Terminal),
      import("@xterm/addon-fit").then((mod) => mod.FitAddon),
      import("@xterm/addon-web-links").then((mod) => mod.WebLinksAddon),
    ])
      .then(([Terminal, FitAddon, WebLinksAddon]) => {
        if (!mounted || !terminalRef.current) return;

        const cursorColor = variant === "orchestrator" ? "#a371f7" : "#5b7ef8";
        const selectionColor =
          variant === "orchestrator"
            ? "rgba(163, 113, 247, 0.25)"
            : "rgba(91, 126, 248, 0.3)";

        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace',
          scrollOnUserInput: true,
          theme: {
            background: "#0a0a0f",
            foreground: "#d4d4d8",
            cursor: cursorColor,
            cursorAccent: "#0a0a0f",
            selectionBackground: selectionColor,
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

        const fit = new FitAddon();
        terminal.loadAddon(fit);
        fitAddon.current = fit;

        const webLinks = new WebLinksAddon();
        terminal.loadAddon(webLinks);

        // XDA handler — makes tmux recognize our terminal and enable clipboard
        terminal.parser.registerCsiHandler(
          { prefix: ">", final: "q" },
          () => {
            terminal.write("\x1bP>|XTerm(370)\x1b\\");
            console.log("[DirectTerminal] Sent XDA response for clipboard support");
            return true;
          },
        );

        terminal.open(terminalRef.current);
        terminalInstance.current = terminal;
        fit.fit();

        // Connect WebSocket
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const hostname = window.location.hostname;
        const port = process.env.NEXT_PUBLIC_DIRECT_TERMINAL_PORT ?? "14801";
        const wsUrl = `${protocol}//${hostname}:${port}/ws?session=${encodeURIComponent(sessionId)}`;

        console.log("[DirectTerminal] Connecting to:", wsUrl);
        const websocket = new WebSocket(wsUrl);
        ws.current = websocket;

        websocket.binaryType = "arraybuffer";

        websocket.onopen = () => {
          console.log("[DirectTerminal] WebSocket connected");
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
          terminal.write(data);
        };

        websocket.onerror = (event) => {
          console.error("[DirectTerminal] WebSocket error:", event);
          setStatus("error");
          setError("WebSocket connection error");
        };

        websocket.onclose = (event) => {
          console.log("[DirectTerminal] WebSocket closed:", event.code, event.reason);
          if (status === "connected") {
            setStatus("error");
            setError("Connection closed");
          }
        };

        // Terminal input → WebSocket
        const disposable = terminal.onData((data) => {
          terminal.scrollToBottom();
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(data);
          }
        });

        // Intercept Ctrl+Shift+C/V (Linux/Win) and Cmd+C/V (Mac) so xterm
        // does NOT process them as terminal input. Returning false prevents
        // xterm from evaluating the key; we then handle clipboard ourselves.
        terminal.attachCustomKeyEventHandler((key: KeyboardEvent) => {
          if (key.type !== "keydown") return true;

          const isMac = navigator.platform.toUpperCase().includes("MAC");

          if (isMac && key.metaKey && !key.ctrlKey && !key.altKey) {
            if (key.code === "KeyC" && terminal.hasSelection()) {
              void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
              return false;
            }
            if (key.code === "KeyV") {
              void navigator.clipboard.readText().then((text) => {
                if (text && websocket.readyState === WebSocket.OPEN) {
                  terminal.paste(text);
                }
              }).catch(() => {});
              return false;
            }
          }

          if (!isMac && key.ctrlKey && key.shiftKey) {
            if (key.code === "KeyC" && terminal.hasSelection()) {
              void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
              return false;
            }
            if (key.code === "KeyV") {
              void navigator.clipboard.readText().then((text) => {
                if (text && websocket.readyState === WebSocket.OPEN) {
                  terminal.paste(text);
                }
              }).catch(() => {});
              return false;
            }
          }

          return true;
        });

        // Handle window resize
        const handleResize = () => {
          if (fit && websocket.readyState === WebSocket.OPEN) {
            fit.fit();
            websocket.send(
              JSON.stringify({
                type: "resize",
                cols: terminal.cols,
                rows: terminal.rows,
              }),
            );
          }
        };

        window.addEventListener("resize", handleResize);

        cleanup = () => {
          window.removeEventListener("resize", handleResize);
          disposable.dispose();
          websocket.close();
          terminal.dispose();
        };
      })
      .catch((err) => {
        console.error("[DirectTerminal] Failed to load xterm.js:", err);
        setStatus("error");
        setError("Failed to load terminal");
      });

    return () => {
      mounted = false;
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
    const maxAttempts = 10;

    const resizeTerminal = () => {
      resizeAttempts++;

      const rect = container.getBoundingClientRect();
      const expectedHeight = rect.height;

      const isFullscreenTarget = fullscreen
        ? expectedHeight > window.innerHeight - 100
        : expectedHeight < 700;

      if (!isFullscreenTarget && resizeAttempts < maxAttempts) {
        requestAnimationFrame(resizeTerminal);
        return;
      }

      terminal.refresh(0, terminal.rows - 1);
      fit.fit();
      terminal.refresh(0, terminal.rows - 1);

      websocket.send(
        JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
    };

    requestAnimationFrame(resizeTerminal);

    const handleTransitionEnd = (e: TransitionEvent) => {
      if (e.target === container.parentElement) {
        resizeAttempts = 0;
        setTimeout(() => requestAnimationFrame(resizeTerminal), 50);
      }
    };

    const parent = container.parentElement;
    parent?.addEventListener("transitionend", handleTransitionEnd);

    const timer1 = setTimeout(() => {
      resizeAttempts = 0;
      resizeTerminal();
    }, 300);
    const timer2 = setTimeout(() => {
      resizeAttempts = 0;
      resizeTerminal();
    }, 600);

    return () => {
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
        {/* Copy Mode toggle */}
        <button
          onClick={copyMode ? exitCopyMode : enterCopyMode}
          className={cn(
            "rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] transition-colors",
            copyMode
              ? "text-[var(--color-status-attention)] bg-[rgba(245,158,11,0.18)] border border-[rgba(245,158,11,0.3)]"
              : "text-[var(--color-text-tertiary)] bg-[rgba(255,255,255,0.05)] hover:text-[var(--color-text-primary)] hover:bg-[rgba(255,255,255,0.1)]",
          )}
          title={copyMode ? "Exit copy mode" : "Freeze output as selectable plain text"}
        >
          {copyMode ? "Exit Copy Mode" : "Copy Mode"}
        </button>
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
      {/* Terminal + Copy Mode overlay */}
      <div className="relative" style={{ height: fullscreen ? "calc(100vh - 37px)" : height }}>
        <div
          ref={terminalRef}
          className={cn("absolute inset-0 w-full p-1.5", copyMode && "invisible")}
          style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
        />
        {copyMode && (
          <div className="absolute inset-0 flex flex-col" style={{ overflow: "hidden" }}>
            <div className="flex shrink-0 items-center gap-2 border-b border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.06)] px-3 py-1.5">
              <span className="text-[11px] font-medium text-[var(--color-status-attention)]">
                Copy Mode — select text below, then Cmd/Ctrl+C to copy
              </span>
              <button
                onClick={copyAll}
                className="ml-auto rounded border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.1)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--color-status-attention)] transition-colors hover:bg-[rgba(245,158,11,0.2)]"
              >
                {copied ? "Copied!" : "Copy All"}
              </button>
              <button
                onClick={exitCopyMode}
                className="rounded border border-[var(--color-border-default)] px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
              >
                Done
              </button>
            </div>
            <div className="flex-1 min-h-0" style={{ overflow: "auto" }}>
              <pre
                className="whitespace-pre p-3 font-[var(--font-mono)] text-[13px] leading-[1.35] text-[#d4d4d8]"
                style={{ background: "#0a0a0f", cursor: "text", userSelect: "text", WebkitUserSelect: "text", tabSize: 8, margin: 0 }}
              >
                {snapshot}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
