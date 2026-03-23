"use client";

import { useSearchParams } from "next/navigation";
import type { DashboardSession } from "@/lib/types";
import { SessionHeader } from "./SessionHeader";
import { PRDetailsPanel } from "./PRDetailsPanel";
import { TerminalEmbed } from "./TerminalEmbed";
import { OrchestratorZone, type OrchestratorZones } from "./OrchestratorZone";
import { activityMeta } from "./session-detail-helpers";

interface SessionDetailProps {
  session: DashboardSession;
  isOrchestrator?: boolean;
  orchestratorZones?: OrchestratorZones;
}

export function SessionDetail({
  session,
  isOrchestrator = false,
  orchestratorZones,
}: SessionDetailProps) {
  const searchParams = useSearchParams();
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const activity = (session.activity && activityMeta[session.activity]) ?? {
    label: session.activity ?? "unknown",
    color: "var(--color-text-muted)",
  };

  const backHref = session.projectId
    ? `/projects/${encodeURIComponent(session.projectId)}`
    : "/";

  const isOpenCodeSession = session.metadata["agent"] === "opencode";
  const opencodeSessionId =
    typeof session.metadata["opencodeSessionId"] === "string" &&
    session.metadata["opencodeSessionId"].length > 0
      ? session.metadata["opencodeSessionId"]
      : undefined;
  const reloadCommand = opencodeSessionId
    ? `/exit\nopencode --session ${opencodeSessionId}\n`
    : undefined;

  return (
    <div className="min-h-screen bg-[var(--color-bg-base)]">
      {/* Nav bar -- glass effect */}
      <nav className="nav-glass sticky top-0 z-10 border-b border-[var(--color-border-subtle)]">
        <div className="mx-auto flex max-w-[900px] items-center gap-2 px-8 py-2.5">
          <a
            href={backHref}
            className="flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
          >
            <svg
              className="h-3 w-3 opacity-60"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Orchestrator
          </a>
          <span className="text-[var(--color-border-strong)]">/</span>
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
            {session.id}
          </span>
          {isOrchestrator && (
            <span
              className="ml-1 rounded px-2 py-0.5 text-[10px] font-semibold tracking-[0.05em]"
              style={{
                color: "var(--color-accent)",
                background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-accent) 20%, transparent)",
              }}
            >
              orchestrator
            </span>
          )}
        </div>
      </nav>

      {/* Orchestrator status strip */}
      {isOrchestrator && orchestratorZones && (
        <OrchestratorZone zones={orchestratorZones} createdAt={session.createdAt} />
      )}

      <div className="mx-auto max-w-[900px] px-8 py-6">
        <SessionHeader session={session} isOrchestrator={isOrchestrator} />

        {session.pr && <PRDetailsPanel pr={session.pr} sessionId={session.id} />}

        <TerminalEmbed
          sessionId={session.id}
          startFullscreen={startFullscreen}
          isOrchestrator={isOrchestrator}
          activityColor={activity.color}
          isOpenCodeSession={isOpenCodeSession}
          reloadCommand={reloadCommand}
          hasPR={!!session.pr}
        />
      </div>
    </div>
  );
}
