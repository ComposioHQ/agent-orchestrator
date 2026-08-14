"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { browserCloudClient } from "@/lib/cloud-client";
import { buildTerminalTheme } from "@/lib/terminal-themes";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export function CloudTerminal({
  organizationId,
  sessionId,
  kind = "agent",
}: {
  organizationId: string;
  sessionId: string;
  kind?: "agent" | "workspace";
}) {
  const client = useMemo(browserCloudClient, []);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [connection, setConnection] =
    useState<ConnectionState>("connecting");
  const [notice, setNotice] = useState("");
  const attemptRef = useRef(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        '"JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      scrollback: 10_000,
      theme: buildTerminalTheme(),
    });
    termRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    let active = true;
    let reconnectTimer: number | undefined;
    let connectSequence = 0;
    let currentAbortController: AbortController | undefined;
    let socket: WebSocket | undefined;

    // Backs off exponentially (capped, with jitter) on repeated failures so a
    // down worker or a rate limit doesn't get hammered by an unbroken 1s
    // retry loop — each failed attempt itself competes for the same
    // per-session outstanding-request budget the worker uses, so retrying
    // too fast can keep that budget pinned and lock the session out of ever
    // recovering.
    const MAX_RECONNECT_DELAY_MS = 30_000;
    const scheduleReconnect = () => {
      if (reconnectTimer !== undefined) return;
      const attempt = attemptRef.current++;
      const backoff = Math.min(
        1_000 * 2 ** attempt,
        MAX_RECONNECT_DELAY_MS,
      );
      const jitter = backoff * (0.75 + Math.random() * 0.5);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, jitter);
    };

    const connect = async () => {
      const sequence = ++connectSequence;
      currentAbortController?.abort();
      currentAbortController = new AbortController();
      setConnection("connecting");
      setNotice("");
      // Every connection — including a reconnect after a network blip or a
      // worker restart — always asks the server to replay from sequence 0,
      // since the client has no way to know what it already rendered. The
      // backend's output isn't idempotent to re-render (it's a raw byte
      // stream, not screen-diff frames), so replaying it into a buffer that
      // already has the same history in it duplicates everything on screen.
      // Clearing first makes each replay authoritative instead of additive.
      terminal.reset();
      try {
        const [ticket, configResponse] = await Promise.all([
          client.createTerminalTicket(organizationId, sessionId, kind, {
            signal: currentAbortController.signal,
          }),
          fetch("/api/cloud/terminal-origin", {
            cache: "no-store",
            signal: currentAbortController.signal,
          }),
        ]);
        if (!configResponse.ok) {
          throw new Error("Could not resolve the terminal endpoint.");
        }
        const config = (await configResponse.json()) as { origin: string };
        const url = new URL("/api/cloud/v1/terminal", config.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket.ticket);
        url.searchParams.set("after", "0");
        url.searchParams.set("kind", kind);
        if (!active || sequence !== connectSequence) return;

        if (
          socket &&
          socket.readyState !== WebSocket.CLOSED &&
          socket.readyState !== WebSocket.CLOSING
        ) {
          socket.close();
        }
        const nextSocket = new WebSocket(url);
        socket = nextSocket;
        let failureHandled = false;
        const reconnectOnce = (state: ConnectionState) => {
          if (!active || sequence !== connectSequence || failureHandled) return;
          failureHandled = true;
          setConnection(state);
          scheduleReconnect();
        };
        nextSocket.binaryType = "arraybuffer";
        nextSocket.addEventListener("open", () => {
          if (!active || sequence !== connectSequence) {
            nextSocket.close();
            return;
          }
          attemptRef.current = 0;
          setConnection("connected");
          nextSocket.send(
            JSON.stringify({
              type: "resize",
              columns: terminal.cols,
              rows: terminal.rows,
            }),
          );
          terminal.focus();
        });
        nextSocket.addEventListener("message", async (event) => {
          if (!active || sequence !== connectSequence) return;
          if (typeof event.data === "string") {
            terminal.write(event.data);
          } else if (event.data instanceof ArrayBuffer) {
            terminal.write(new Uint8Array(event.data));
          } else if (event.data instanceof Blob) {
            terminal.write(new Uint8Array(await event.data.arrayBuffer()));
          }
        });
        nextSocket.addEventListener("close", (event) => {
          if (!active || sequence !== connectSequence || failureHandled) return;
          if (event.code === 1000) {
            setNotice(
              kind === "agent"
                ? "Agent terminal stream closed. Reconnecting…"
                : "Terminal stream closed. Reconnecting…",
            );
          }
          reconnectOnce("disconnected");
        });
        nextSocket.addEventListener("error", () => {
          reconnectOnce("error");
        });
      } catch (cause) {
        if (
          !active ||
          sequence !== connectSequence ||
          currentAbortController.signal.aborted
        ) {
          return;
        }
        setConnection("error");
        setNotice(
          cause instanceof Error ? cause.message : "Could not open terminal.",
        );
        scheduleReconnect();
      }
    };

    const input = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: "resize", columns: cols, rows }),
        );
      }
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = buildTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-style-theme"],
    });

    void connect();

    return () => {
      active = false;
      connectSequence++;
      currentAbortController?.abort();
      termRef.current = null;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      themeObserver.disconnect();
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [client, kind, organizationId, sessionId]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 5_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  return (
    <div className="relative min-h-0 flex-1 bg-[var(--color-bg-terminal-opaque)]">
      {connection !== "connected" ? (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[var(--color-bg-terminal-opaque)]/92">
          <div className="text-center">
            <div className="relative mx-auto mb-3 size-8">
              <span className="absolute inset-0 rounded-full border border-[var(--color-status-working)]/20" />
              <span className="absolute inset-1 animate-spin rounded-full border border-transparent border-t-[var(--color-status-working)] motion-reduce:animate-none" />
            </div>
            <p className="text-xs text-[var(--muted-foreground)]">
              {connection === "connecting"
                ? "Connecting terminal…"
                : connection === "disconnected"
                  ? "Reconnecting terminal…"
                  : "Terminal unavailable"}
            </p>
            {notice ? (
              <p className="mt-2 max-w-72 text-[10px] leading-4 text-[var(--error)]">
                {notice}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="h-full min-h-0 w-full p-2" ref={hostRef} />
    </div>
  );
}
