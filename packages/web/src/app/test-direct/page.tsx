"use client";

import { DirectTerminal } from "@/components/DirectTerminal";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

// Force dynamic rendering (required for useSearchParams)
export const dynamic = "force-dynamic";

/**
 * Test page for DirectTerminal using ghostty-web.
 *
 * Examples:
 * - http://localhost:3000/test-direct
 * - http://localhost:3000/test-direct?session=ao-20
 * - http://localhost:3000/test-direct?session=ao-20&fullscreen=true
 */
function TestDirectPageContent() {
  const searchParams = useSearchParams();
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const sessionId = searchParams.get("session") || "ao-orchestrator";
  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] p-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            DirectTerminal Test - Ghostty Web
          </h1>
          <p className="mt-2 text-sm text-[var(--color-text-muted)]">
            This terminal uses Ghostty's web terminal emulator.
            <br />
            Clipboard, selection, resize, and shell I/O should behave through the native PTY bridge.
          </p>
          <div className="mt-4 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
            <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
              Testing: <span className="text-[var(--color-accent-green)]">{sessionId}</span>
            </h2>
            <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
              Test Steps:
            </h2>
            <ol className="list-inside list-decimal space-y-1 text-sm text-[var(--color-text-muted)]">
              <li>Connected to tmux session: {sessionId}</li>
              <li>
                Verify emulator badge shows{" "}
                <span className="text-[var(--color-accent-green)]">✓ Ghostty</span>
              </li>
              <li>Drag-select text in the terminal</li>
              <li>Press Cmd+C (macOS) or Ctrl+C (Linux/Windows)</li>
              <li>Paste elsewhere to verify clipboard works</li>
              <li>
                <strong>Expected:</strong> Clipboard works without iTerm2 attachment!
              </li>
            </ol>
          </div>
          <div className="mt-4 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
            <h2 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
              Technical Details:
            </h2>
            <ul className="list-inside list-disc space-y-1 text-sm text-[var(--color-text-muted)]">
              <li>Uses `ghostty-web` instead of `xterm.js` in the browser</li>
              <li>Keeps the existing node-pty + WebSocket transport to tmux</li>
              <li>Auto-fits the canvas to the terminal container</li>
              <li>Preserves copy, paste, resize, reconnect, and link detection behavior</li>
            </ul>
          </div>
        </div>

        {/* Test with specified session - key forces remount on fullscreen change */}
        <DirectTerminal
          key={`${sessionId}-${startFullscreen ? "fullscreen" : "normal"}`}
          sessionId={sessionId}
          startFullscreen={startFullscreen}
        />
      </div>
    </div>
  );
}

export default function TestDirectPage() {
  return (
    <Suspense
      fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}
    >
      <TestDirectPageContent />
    </Suspense>
  );
}
