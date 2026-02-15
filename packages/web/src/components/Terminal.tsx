"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

interface TerminalProps {
  sessionId: string;
}

/**
 * Terminal embed using ttyd (iframe).
 * ttyd handles xterm.js, WebSocket, ANSI rendering, resize, input — everything.
 * We proxy ttyd through Next.js to keep everything same-origin, which:
 * - Allows clipboard operations (document.execCommand)
 * - Prevents cross-origin "Leave Site?" dialogs
 */
export function Terminal({ sessionId }: TerminalProps) {
  const [fullscreen, setFullscreen] = useState(false);
  // Use same-origin proxy URL (no cross-origin fetch needed)
  const terminalUrl = `/terminal-proxy/ttyd/${encodeURIComponent(sessionId)}`;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-black",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2">
        <div className="h-2 w-2 rounded-full bg-[#3fb950]" />
        <span className="font-[var(--font-mono)] text-xs text-[var(--color-text-muted)]">
          {sessionId}
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-accent-green)]">
          Connected
        </span>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {fullscreen ? "exit fullscreen" : "fullscreen"}
        </button>
      </div>
      <div className={cn("w-full", fullscreen ? "h-[calc(100vh-40px)]" : "h-[600px]")}>
        <iframe
          src={terminalUrl}
          className="h-full w-full border-0"
          title={`Terminal: ${sessionId}`}
        />
      </div>
    </div>
  );
}
