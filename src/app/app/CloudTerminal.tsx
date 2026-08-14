"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { browserCloudClient } from "@/lib/cloud-client";
import {
  type CloudTerminalConnectionState,
  ensureCloudTerminalConnection,
} from "@/lib/cloud-terminal-pool";
import { buildTerminalTheme } from "@/lib/terminal-themes";

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
    useState<CloudTerminalConnectionState>("connecting");
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
      theme: buildTerminalTheme(),
    });
    termRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const fitTerminal = () => fit.fit();
    fitTerminal();
    const firstFrame = window.requestAnimationFrame(fitTerminal);
    const secondFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(fitTerminal);
    });

    const persistentConnection = ensureCloudTerminalConnection(
      client,
      organizationId,
      sessionId,
      kind,
    );
    persistentConnection.resize(terminal.rows, terminal.cols);
    const unsubscribe = persistentConnection.subscribe((event) => {
      if (event.type === "state") {
        setConnection(event.state);
      } else if (event.type === "reset") {
        terminal.reset();
        terminal.clear();
      } else if (event.type === "notice") {
        setNotice(event.message);
      } else {
        terminal.write(event.data);
      }
    });

    const input = terminal.onData((data) => {
      persistentConnection.sendInput(data);
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      persistentConnection.resize(rows, cols);
    });
    const observer = new ResizeObserver(() => {
      fitTerminal();
      persistentConnection.resize(terminal.rows, terminal.cols);
    });
    observer.observe(host);
    if (host.parentElement) observer.observe(host.parentElement);

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = buildTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-style-theme"],
    });

    return () => {
      termRef.current = null;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      themeObserver.disconnect();
      observer.disconnect();
      unsubscribe();
      input.dispose();
      resize.dispose();
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
