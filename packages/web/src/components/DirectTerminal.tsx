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
export function DirectTerminal({ sessionId, startFullscreen = false }: DirectTerminalProps) {
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
    // Prevent retry loop on persistent errors
    if (error && status === "error") return;

    // Dynamically import xterm.js to avoid SSR issues
    let mounted = true;
    let cleanup: (() => void) | null = null;

    Promise.all([
      import("xterm").then((mod) => mod.Terminal),
      import("@xterm/addon-fit").then((mod) => mod.FitAddon),
      import("@xterm/addon-web-links").then((mod) => mod.WebLinksAddon),
    ])
      .then(([Terminal, FitAddon, WebLinksAddon]) => {
        if (!mounted || !terminalRef.current) return;

        // Initialize xterm.js Terminal
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: 14,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          theme: {
            background: "#000000",
            foreground: "#ffffff",
            cursor: "#ffffff",
            cursorAccent: "#000000",
            selectionBackground: "rgba(255, 255, 255, 0.3)",
          },
          scrollback: 10000,
          allowProposedApi: true, // Required for some advanced features
          // Smooth scrolling configuration
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

        // Open terminal in DOM
        terminal.open(terminalRef.current);
        terminalInstance.current = terminal;

        // Fit terminal to container
        fit.fit();

        // Connect WebSocket
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const hostname = window.location.hostname;
        const port = process.env.NEXT_PUBLIC_DIRECT_TERMINAL_PORT ?? "3003";
        const wsUrl = `${protocol}//${hostname}:${port}/ws?session=${encodeURIComponent(sessionId)}`;

        console.log("[DirectTerminal] Connecting to:", wsUrl);
        const websocket = new WebSocket(wsUrl);
        ws.current = websocket;

        websocket.binaryType = "arraybuffer";

        websocket.onopen = () => {
          console.log("[DirectTerminal] WebSocket connected");
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
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
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
          if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(data);
          }
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

        // Store cleanup function to be called from useEffect cleanup
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
  }, [sessionId]);

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

      // Get container dimensions
      const rect = container.getBoundingClientRect();
      const expectedHeight = rect.height;

      // Check if container has reached target dimensions (within 10px tolerance)
      const isFullscreenTarget = fullscreen ? expectedHeight > window.innerHeight - 100 : expectedHeight < 700;

      if (!isFullscreenTarget && resizeAttempts < maxAttempts) {
        // Container hasn't reached target size yet, try again
        requestAnimationFrame(resizeTerminal);
        return;
      }

      // Container is at target size, now resize terminal
      terminal.refresh(0, terminal.rows - 1);
      fit.fit();
      terminal.refresh(0, terminal.rows - 1);

      // Send new size to server
      websocket.send(
        JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      );
    };

    // Start resize polling
    requestAnimationFrame(resizeTerminal);

    // Also try on transitionend
    const handleTransitionEnd = (e: TransitionEvent) => {
      if (e.target === container.parentElement) {
        resizeAttempts = 0;
        setTimeout(() => requestAnimationFrame(resizeTerminal), 50);
      }
    };

    const parent = container.parentElement;
    parent?.addEventListener("transitionend", handleTransitionEnd);

    // Backup timers in case RAF polling doesn't work
    const timer1 = setTimeout(() => { resizeAttempts = 0; resizeTerminal(); }, 300);
    const timer2 = setTimeout(() => { resizeAttempts = 0; resizeTerminal(); }, 600);

    return () => {
      parent?.removeEventListener("transitionend", handleTransitionEnd);
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [fullscreen]);

  const statusColor =
    status === "connected" ? "bg-[#3fb950]" : status === "error" ? "bg-[#f85149]" : "bg-[#d29922] animate-pulse";

  const statusText =
    status === "connected" ? "Connected" : status === "error" ? error ?? "Error" : "Connecting...";

  const statusTextColor =
    status === "connected"
      ? "text-[var(--color-accent-green)]"
      : status === "error"
        ? "text-[var(--color-accent-red)]"
        : "text-[var(--color-text-muted)]";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-black",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2">
        <div className={cn("h-2 w-2 rounded-full", statusColor)} />
        <span className="font-[var(--font-mono)] text-xs text-[var(--color-text-muted)]">{sessionId}</span>
        <span className={cn("text-[10px] font-medium uppercase tracking-wide", statusTextColor)}>{statusText}</span>
        <span className="ml-2 rounded bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--color-accent-green)]">
          XDA
        </span>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {fullscreen ? "exit fullscreen" : "fullscreen"}
        </button>
      </div>
      <div
        ref={terminalRef}
        className={cn("w-full p-2", fullscreen ? "h-[calc(100vh-40px)]" : "h-[600px]")}
        style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
      />
    </div>
  );
}
