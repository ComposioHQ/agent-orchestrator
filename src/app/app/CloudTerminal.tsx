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
  layoutKey?: string;
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
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        '"JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: buildTerminalTheme(),
    });
    termRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    const fitTerminal = () => {
      if (host.clientWidth < 40 || host.clientHeight < 40) return;
      try {
        fit.fit();
      } catch {
        // A later layout or font event retries transient zero-sized hosts.
      }
    };

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
    const FIT_QUIET_MS = 120;
    const FIT_CAP_MS = 500;
    let fitQuietTimer: number | undefined;
    let fitCapTimer: number | undefined;
    let disposed = false;
    const flushScheduledFit = () => {
      if (disposed) return;
      if (fitQuietTimer !== undefined) window.clearTimeout(fitQuietTimer);
      if (fitCapTimer !== undefined) window.clearTimeout(fitCapTimer);
      fitQuietTimer = undefined;
      fitCapTimer = undefined;
      fitTerminal();
      persistentConnection.resize(terminal.rows, terminal.cols);
    };
    const scheduleStableFit = () => {
      if (disposed) return;
      if (fitQuietTimer !== undefined) window.clearTimeout(fitQuietTimer);
      fitQuietTimer = window.setTimeout(flushScheduledFit, FIT_QUIET_MS);
      if (fitCapTimer === undefined) {
        fitCapTimer = window.setTimeout(flushScheduledFit, FIT_CAP_MS);
      }
    };

    const firstFrame = window.requestAnimationFrame(fitTerminal);
    const settleTimers = [50, 250, 600, 1200].map((delay) =>
      window.setTimeout(scheduleStableFit, delay),
    );
    const observer = new ResizeObserver(scheduleStableFit);
    observer.observe(host);
    void document.fonts?.ready.then(() => {
      if (!disposed) scheduleStableFit();
    });
    const STABLE_FRAMES_TARGET = 3;
    const MAX_REFITS = 20;
    let stableFrames = 0;
    let refits = 0;
    let pending: { cols: number; rows: number } | null = null;
    const stabilizer = terminal.onRender(() => {
      const proposed = fit.proposeDimensions();
      if (!proposed || proposed.cols < 20 || proposed.rows < 4) return;
      if (proposed.cols !== terminal.cols || proposed.rows !== terminal.rows) {
        stableFrames = 0;
        if (pending && pending.cols === proposed.cols && pending.rows === proposed.rows) {
          pending = null;
          if (refits++ >= MAX_REFITS) {
            stabilizer.dispose();
            return;
          }
          fitTerminal();
          return;
        }
        pending = proposed;
        return;
      }
      pending = null;
      if (++stableFrames >= STABLE_FRAMES_TARGET) stabilizer.dispose();
    });
    window.addEventListener("resize", scheduleStableFit);

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = buildTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-style-theme"],
    });

    return () => {
      disposed = true;
      termRef.current = null;
      if (fitQuietTimer !== undefined) window.clearTimeout(fitQuietTimer);
      if (fitCapTimer !== undefined) window.clearTimeout(fitCapTimer);
      for (const timer of settleTimers) window.clearTimeout(timer);
      window.cancelAnimationFrame(firstFrame);
      window.removeEventListener("resize", scheduleStableFit);
      stabilizer.dispose();
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
          </div>
        </div>
      ) : null}
      {notice ? (
        <div
          className="pointer-events-none absolute bottom-3 left-1/2 z-20 max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-md border border-[var(--color-error)]/30 bg-[var(--color-bg-secondary)]/95 px-3 py-2 text-xs text-[var(--error)] shadow-lg"
          role="status"
        >
          {notice}
        </div>
      ) : null}
      <div className="h-full min-h-0 w-full p-2" ref={hostRef} />
    </div>
  );
}
