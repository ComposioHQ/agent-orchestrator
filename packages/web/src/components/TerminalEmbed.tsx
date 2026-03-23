"use client";

import { DirectTerminal } from "./DirectTerminal";

interface TerminalEmbedProps {
  sessionId: string;
  startFullscreen: boolean;
  isOrchestrator: boolean;
  activityColor: string;
  isOpenCodeSession: boolean;
  reloadCommand?: string;
  hasPR: boolean;
}

export function TerminalEmbed({
  sessionId,
  startFullscreen,
  isOrchestrator,
  activityColor,
  isOpenCodeSession,
  reloadCommand,
  hasPR,
}: TerminalEmbedProps) {
  const accentColor = "var(--color-accent)";
  const terminalVariant = isOrchestrator ? "orchestrator" : "agent";
  const terminalHeight = isOrchestrator
    ? "calc(100vh - 240px)"
    : "max(440px, calc(100vh - 440px))";
  const indicatorColor = isOrchestrator ? accentColor : activityColor;

  return (
    <div className={hasPR ? "mt-6" : ""}>
      <div className="mb-3 flex items-center gap-2">
        <div
          className="h-3 w-0.5 rounded-full opacity-70"
          style={{ background: indicatorColor }}
        />
        <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
          Terminal
        </span>
      </div>
      <DirectTerminal
        sessionId={sessionId}
        startFullscreen={startFullscreen}
        variant={terminalVariant}
        height={terminalHeight}
        isOpenCodeSession={isOpenCodeSession}
        reloadCommand={isOpenCodeSession ? reloadCommand : undefined}
      />
    </div>
  );
}
