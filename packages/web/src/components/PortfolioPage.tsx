"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ProjectSidebar } from "./ProjectSidebar";
import { ThemeToggle } from "./ThemeToggle";
import type { ProjectInfo } from "@/lib/project-name";
import { getAttentionLevel, type DashboardSession } from "@/lib/types";
import { useSessionEvents } from "@/hooks/useSessionEvents";

interface ProjectCardData {
  id: string;
  name: string;
  sessionCounts: {
    total: number;
    working: number;
    pending: number;
    review: number;
    respond: number;
    ready: number;
  };
}

interface PortfolioPageProps {
  projects: ProjectInfo[];
  initialCards: ProjectCardData[];
  initialSessions?: DashboardSession[];
}

type PortfolioBucket = keyof ProjectCardData["sessionCounts"] | "done";

/** Map canonical AttentionLevel to a portfolio bucket */
function attentionLevelToBucket(session: DashboardSession): PortfolioBucket {
  const level = getAttentionLevel(session);
  if (level === "merge") return "ready";
  return level; // "respond" | "review" | "pending" | "working" | "done" map 1:1
}

function SessionCountBadge({ label, count, color }: { label: string; count: number; color: string }) {
  if (count === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${color}`}>
      {count} {label}
    </span>
  );
}

function ProjectCard({ card }: { card: ProjectCardData }) {
  const { sessionCounts } = card;

  return (
    <Link
      href={`/projects/${encodeURIComponent(card.id)}`}
      className="group block rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-5 transition-all hover:border-[var(--color-border-active)] hover:shadow-md"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-accent)]">
          {card.name}
        </h2>
        <span className="text-sm text-[var(--color-text-tertiary)]">
          {sessionCounts.total} session{sessionCounts.total !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <SessionCountBadge label="Working" count={sessionCounts.working} color="bg-blue-500/10 text-blue-400" />
        <SessionCountBadge label="Pending" count={sessionCounts.pending} color="bg-yellow-500/10 text-yellow-400" />
        <SessionCountBadge label="Review" count={sessionCounts.review} color="bg-purple-500/10 text-purple-400" />
        <SessionCountBadge label="Respond" count={sessionCounts.respond} color="bg-red-500/10 text-red-400" />
        <SessionCountBadge label="Ready" count={sessionCounts.ready} color="bg-green-500/10 text-green-400" />
      </div>
    </Link>
  );
}

export function PortfolioPage({ projects, initialCards, initialSessions = [] }: PortfolioPageProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Use SSE-driven session stream (same infrastructure as the project dashboard).
  // No project filter — we need sessions for all projects.
  const { sessions } = useSessionEvents(initialSessions);

  // Recompute card counts whenever sessions update via SSE.
  // Memoized to avoid re-renders on unrelated state changes.
  const cards = useMemo<ProjectCardData[]>(() => {
    // If SSE hasn't delivered any sessions yet, show the server-rendered initial cards.
    if (sessions.length === 0 && initialSessions.length === 0) return initialCards;

    const cardMap = new Map<string, ProjectCardData>();
    for (const p of projects) {
      cardMap.set(p.id, {
        id: p.id,
        name: p.name,
        sessionCounts: { total: 0, working: 0, pending: 0, review: 0, respond: 0, ready: 0 },
      });
    }
    for (const session of sessions) {
      const card = cardMap.get(session.projectId);
      if (!card) continue;
      const bucket = attentionLevelToBucket(session);
      if (bucket !== "done") {
        card.sessionCounts.total++;
        card.sessionCounts[bucket as keyof typeof card.sessionCounts]++;
      }
    }
    return [...cardMap.values()];
  }, [sessions, projects, initialCards, initialSessions]);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-bg-base)]">
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId={undefined}
        activeSessionId={undefined}
        collapsed={!sidebarOpen}
        onToggleCollapsed={() => setSidebarOpen(!sidebarOpen)}
      />

      <main className="flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg-base)]/80 px-6 py-4 backdrop-blur-sm">
          <div>
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">All Projects</h1>
            <p className="text-sm text-[var(--color-text-tertiary)]">
              {projects.length} project{projects.length !== 1 ? "s" : ""} registered
            </p>
          </div>
          <ThemeToggle />
        </header>

        <div className="p-6">
          {cards.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <p className="text-lg text-[var(--color-text-secondary)]">No projects registered</p>
              <p className="mt-2 text-sm text-[var(--color-text-tertiary)]">
                Run <code className="rounded bg-[var(--color-bg-surface)] px-1.5 py-0.5 font-mono text-xs">ao start</code> in a project directory to register it.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((card) => (
                <ProjectCard key={card.id} card={card} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
