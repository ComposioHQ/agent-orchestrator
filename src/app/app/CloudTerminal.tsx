"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { browserCloudClient } from "@/lib/cloud-client";

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
  const [connection, setConnection] =
    useState<ConnectionState>("connecting");
  const [notice, setNotice] = useState("");

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
      theme: {
        background: "#101317",
        foreground: "#d7d7d2",
        cursor: "#4d8dff",
        cursorAccent: "#101317",
        selectionBackground: "#4d8dff4d",
        black: "#1f2329",
        red: "#f05d5e",
        green: "#44c97a",
        yellow: "#e5c34b",
        blue: "#5b9cff",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#d7dae0",
        brightBlack: "#7f8792",
        brightRed: "#ff7b7c",
        brightGreen: "#62df91",
        brightYellow: "#f2d66d",
        brightBlue: "#79b1ff",
        brightMagenta: "#d99aee",
        brightCyan: "#79d4df",
        brightWhite: "#f4f5f7",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    let active = true;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | undefined;

    const connect = async () => {
      setConnection("connecting");
      setNotice("");
      try {
        const [ticket, configResponse] = await Promise.all([
          client.createTerminalTicket(organizationId, sessionId, kind),
          fetch("/api/cloud/terminal-origin", { cache: "no-store" }),
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
        if (!active) return;

        socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => {
          setConnection("connected");
          socket?.send(
            JSON.stringify({
              type: "resize",
              columns: terminal.cols,
              rows: terminal.rows,
            }),
          );
          terminal.focus();
        });
        socket.addEventListener("message", async (event) => {
          if (typeof event.data === "string") {
            terminal.write(event.data);
          } else if (event.data instanceof ArrayBuffer) {
            terminal.write(new Uint8Array(event.data));
          } else if (event.data instanceof Blob) {
            terminal.write(new Uint8Array(await event.data.arrayBuffer()));
          }
        });
        socket.addEventListener("close", (event) => {
          if (!active) return;
          setConnection("disconnected");
          if (event.code === 1000) {
            setNotice(kind === "agent" ? "Agent terminal exited." : "Terminal closed.");
            return;
          }
          reconnectTimer = window.setTimeout(() => void connect(), 1_000);
        });
        socket.addEventListener("error", () => {
          setConnection("error");
        });
      } catch (cause) {
        if (!active) return;
        setConnection("error");
        setNotice(
          cause instanceof Error ? cause.message : "Could not open terminal.",
        );
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
    void connect();

    return () => {
      active = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
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
    <div className="relative min-h-0 flex-1 bg-[#101317]">
      {connection !== "connected" ? (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[#101317]/92">
          <div className="text-center">
            <div className="relative mx-auto mb-3 size-8">
              <span className="absolute inset-0 rounded-full border border-[#4d8dff]/20" />
              <span className="absolute inset-1 animate-spin rounded-full border border-transparent border-t-[#6f9eff] motion-reduce:animate-none" />
            </div>
            <p className="text-xs text-[#c4c8cf]">
              {connection === "connecting"
                ? "Connecting terminal…"
                : connection === "disconnected"
                  ? "Reconnecting terminal…"
                  : "Terminal unavailable"}
            </p>
            {notice ? (
              <p className="mt-2 max-w-72 text-[10px] leading-4 text-[#ef9b9b]">
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
