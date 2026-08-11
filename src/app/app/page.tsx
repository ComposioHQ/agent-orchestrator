"use client";

import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";

import {
  CloudDemoCommandMenu,
  CloudDemoSettingsDialog,
} from "./CloudDemoOverlays";
import { CloudDemoMainShell, CloudDemoTopbar } from "./CloudDemoShell";
import { CloudDemoSidebar } from "./CloudDemoSidebar";
import type { DemoSession, DemoSessionStatus } from "./demo-types";

const sessions: DemoSession[] = [
  {
    id: "demo-codex",
    harness: "codex",
    displayName: "Build cloud authentication",
    branch: "feat/cloud-auth",
    activityState: "active",
    status: "working",
    age: "7h",
  },
  {
    id: "demo-claude",
    harness: "claude-code",
    displayName: "Review onboarding flow",
    branch: "review/onboarding",
    activityState: "waiting_input",
    status: "needs_input",
    age: "7h",
  },
  {
    id: "demo-cursor",
    harness: "cursor",
    displayName: "Polish workspace navigation",
    branch: "feat/workspace-nav",
    activityState: "idle",
    status: "review_pending",
    age: "7h",
  },
  {
    id: "demo-ready",
    harness: "codex",
    displayName: "Add cloud board routes",
    branch: "feat/cloud-board",
    activityState: "idle",
    status: "mergeable",
    age: "8h",
  },
];

const columns: Array<{
  title: string;
  dot: string;
  statuses: DemoSessionStatus[];
}> = [
  { title: "Working", dot: "#36c2b4", statuses: ["working"] },
  { title: "Needs you", dot: "#f2b84b", statuses: ["needs_input"] },
  { title: "In review", dot: "#5b8def", statuses: ["review_pending"] },
  { title: "Ready to merge", dot: "#9ad97a", statuses: ["mergeable"] },
];

const statusView: Record<DemoSessionStatus, { label: string; color: string }> = {
  working: { label: "Working", color: "text-[#f59f4c]" },
  needs_input: { label: "Needs input", color: "text-[#e8c14a]" },
  review_pending: { label: "Review pending", color: "text-[#5b8def]" },
  mergeable: { label: "Ready to merge", color: "text-[#78c997]" },
};

function AgentAvatar({ agent }: { agent: string }) {
  return (
    <img
      src={`/agents/${agent}.svg`}
      alt=""
      aria-hidden="true"
      className="mt-0.5 size-[18px] shrink-0 object-contain"
      draggable={false}
    />
  );
}

function SessionCard({ session }: { session: DemoSession }) {
  const status = statusView[session.status];

  return (
    <button
      type="button"
      data-testid="cloud-board-session-card"
      className="group relative w-full cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--color-bg-secondary)] text-left transition-[border-color,box-shadow] hover:border-[var(--color-border-strong)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/60"
    >
      <div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
        <AgentAvatar agent={session.harness} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 overflow-hidden text-[11.5px] font-semibold leading-tight tracking-[-0.01em] text-[var(--foreground)]">
            {session.displayName}
          </div>
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-[var(--color-text-passive)]">
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{session.branch}</span>
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="mx-3.5 my-px h-px bg-[var(--border)]" />
      <div className="flex items-center justify-between gap-2 px-3.5 py-2">
        <span
          className={`inline-flex min-w-0 items-center gap-1.5 truncate text-[10.5px] font-medium ${status.color}`}
        >
          <span className="size-[7px] shrink-0 rounded-full bg-current" />
          {status.label}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] text-[var(--color-text-passive)]">
          {session.age}
        </span>
      </div>
    </button>
  );
}

function SessionBoard() {
  return (
    <div className="grid h-full min-h-0 min-w-[64rem] grid-cols-4 divide-x divide-[var(--border)] overflow-x-auto xl:min-w-0">
      {columns.map((column) => {
        const columnSessions = sessions.filter((session) =>
          column.statuses.includes(session.status),
        );

        return (
          <section
            key={column.title}
            aria-label={`${column.title} sessions`}
            className="min-w-[230px] overflow-auto"
          >
            <div className="flex h-12 items-center gap-2.5 border-b border-[var(--border)] px-4">
              <span
                className="size-[7px] rounded-full"
                style={{ backgroundColor: column.dot }}
              />
              <h2 className="text-[11.5px] font-medium tracking-[-0.01em] text-[var(--color-text-muted)]">
                {column.title}
              </h2>
              <span className="ml-auto font-mono text-[10px] text-[var(--color-text-passive)]">
                {columnSessions.length}
              </span>
            </div>
            <div className="space-y-2 p-3">
              {columnSessions.map((session) => (
                <SessionCard key={session.id} session={session} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function CloudBoardDemo() {
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main
      data-testid="cloud-board-demo"
      className="fixed inset-0 h-dvh overflow-hidden bg-[var(--color-bg-primary)] font-sans tracking-normal text-[var(--color-text-primary)] [color-scheme:dark] [&_*]:[scrollbar-color:rgb(255_255_255_/_12%)_transparent] [&_*]:[scrollbar-width:thin]"
    >
      <div className="grid h-full grid-cols-[240px_minmax(0,1fr)]">
        <CloudDemoSidebar
          sessions={sessions}
          onOpenCommand={() => setCommandOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <CloudDemoMainShell>
          <CloudDemoTopbar title="Cloud platform" />
          <div className="min-h-0 flex-1">
            <SessionBoard />
          </div>
        </CloudDemoMainShell>
      </div>
      <CloudDemoCommandMenu
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <CloudDemoSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </main>
  );
}

export default CloudBoardDemo;
