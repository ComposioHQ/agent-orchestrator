"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import "xterm/css/xterm.css";
import type { Terminal as TerminalType } from "xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import { buildTerminalTheme, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_SCROLLBACK, TERMINAL_BACKGROUND, type TerminalVariant, type TerminalStatus } from "./TerminalTheme";
import { useTerminalResize, sendResizeMessage } from "./TerminalResize";
import { TerminalChromeBar } from "./TerminalChromeBar";
import { buildDirectTerminalWsUrl } from "@/lib/terminal-ws-url";
export { buildDirectTerminalWsUrl } from "@/lib/terminal-ws-url";

interface DirectTerminalProps {
  sessionId: string;
  startFullscreen?: boolean;
  /** Visual variant. "orchestrator" uses violet accent; "agent" (default) uses blue. */
  variant?: TerminalVariant;
  /** CSS height for the terminal container in normal (non-fullscreen) mode.
   *  Defaults to "max(440px, calc(100vh - 440px))". */
  height?: string;
  isOpenCodeSession?: boolean;
  reloadCommand?: string;
}

/** Direct xterm.js terminal with native WebSocket and XDA/OSC 52 clipboard support. */
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
  const fitAddonRef = useRef<FitAddonType | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const permanentErrorRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(startFullscreen);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  // Stable getter for the current WebSocket (used by resize hook)
  const getWebSocket = useCallback(() => ws.current, []);

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
    ])
      .then(([Terminal, FitAddon, WebLinksAddon]) => {
        if (!mounted || !terminalRef.current) return;

        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: TERMINAL_FONT_SIZE,
          fontFamily: TERMINAL_FONT_FAMILY,
          theme: buildTerminalTheme(variant),
          scrollback: TERMINAL_SCROLLBACK,
          allowProposedApi: true,
          fastScrollModifier: "alt",
          fastScrollSensitivity: 3,
          scrollSensitivity: 1,
        });

        const fit = new FitAddon();
        terminal.loadAddon(fit);
        fitAddonRef.current = fit;
        terminal.loadAddon(new WebLinksAddon());

        // Register XDA handler for tmux clipboard support
        terminal.parser.registerCsiHandler(
          { prefix: ">", final: "q" },
          () => {
            terminal.write("\x1bP>|XTerm(370)\x1b\\");
            console.log("[DirectTerminal] Sent XDA response for clipboard support");
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
        fit.fit();
        const wsUrl = buildDirectTerminalWsUrl({
          location: window.location,
          sessionId,
          proxyWsPath: process.env.NEXT_PUBLIC_TERMINAL_WS_PATH,
          directTerminalPort: process.env.NEXT_PUBLIC_DIRECT_TERMINAL_PORT,
        });

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
            sendResizeMessage(currentWs, terminal.cols, terminal.rows);
          }
        };

        window.addEventListener("resize", handleResize);
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

            sendResizeMessage(websocket, terminal.cols, terminal.rows);
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
            console.log("[DirectTerminal] WebSocket closed:", event.code, event.reason);

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

            console.log(`[DirectTerminal] Reconnecting in ${delay}ms (attempt ${attempt + 1})`);
            setStatus("connecting");
            setError(null);

            reconnectTimerRef.current = setTimeout(connectWebSocket, delay);
          };
        }

        connectWebSocket();

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

  // Re-fit terminal when fullscreen changes
  useTerminalResize({
    terminalRef: terminalInstance,
    fitAddonRef,
    getWebSocket,
    containerRef: terminalRef,
    fullscreen,
  });

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-default)]",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
      style={{ backgroundColor: TERMINAL_BACKGROUND }}
    >
      <TerminalChromeBar
        sessionId={sessionId}
        variant={variant}
        status={status}
        error={error}
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen(!fullscreen)}
        isOpenCodeSession={isOpenCodeSession}
        reloading={reloading}
        reloadError={reloadError}
        onReload={handleReload}
      />
      {/* Terminal area */}
      <div
        ref={terminalRef}
        className="flex w-full flex-col overflow-hidden p-1.5"
        style={{
          height: fullscreen ? "calc(100vh - 37px)" : height,
        }}
      />
    </div>
  );
}
