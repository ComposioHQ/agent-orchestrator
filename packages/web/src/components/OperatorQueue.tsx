"use client";

import { useState } from "react";
import { type DashboardSession, getAttentionLevel } from "@/lib/types";

interface OperatorQueueProps {
  sessions: DashboardSession[];
  onSend?: (sessionId: string, message: string) => Promise<void> | void;
  onMerge?: (prNumber: number) => Promise<void> | void;
  onRestore?: (sessionId: string) => Promise<void> | void;
}

interface QueueItem {
  session: DashboardSession;
  title: string;
  note: string;
  actionLabel: string;
  actionKind: "send" | "merge" | "restore";
  actionPayload: string | number;
  priority: number;
}

export function OperatorQueue({ sessions, onSend, onMerge, onRestore }: OperatorQueueProps) {
  const [pending, setPending] = useState<string | null>(null);
  const items = buildQueueItems(sessions).slice(0, 6);
  const focus = items[0] ?? null;

  if (items.length === 0) {
    return null;
  }

  const handleAction = async (item: QueueItem) => {
    setPending(item.session.id);
    try {
      if (item.actionKind === "send") {
        await onSend?.(item.session.id, String(item.actionPayload));
      } else if (item.actionKind === "merge") {
        await onMerge?.(Number(item.actionPayload));
      } else {
        await onRestore?.(item.session.id);
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="mb-7 rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Next Actions
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
            Highest-leverage operator actions, ordered by urgency.
          </p>
        </div>
        <span className="rounded-full border border-[var(--color-border-subtle)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">
          {items.length} queued
        </span>
      </div>
      {focus && (
        <div className="mb-3 rounded-[7px] border border-[rgba(88,166,255,0.18)] bg-[linear-gradient(135deg,rgba(88,166,255,0.1),rgba(88,166,255,0.03))] p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-accent)]">
                Focus Session
              </div>
              <a
                href={`/sessions/${encodeURIComponent(focus.session.id)}`}
                className="mt-1 block font-[var(--font-mono)] text-[13px] font-semibold text-[var(--color-text-primary)] hover:no-underline"
              >
                {focus.session.id}
              </a>
              <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">{focus.note}</p>
            </div>
            <button
              onClick={() => void handleAction(focus)}
              disabled={pending === focus.session.id}
              className="rounded-[5px] border border-[rgba(88,166,255,0.28)] bg-[rgba(9,105,218,0.08)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-accent)] transition-colors hover:bg-[rgba(9,105,218,0.14)] disabled:opacity-50"
            >
              {pending === focus.session.id ? "sending..." : focus.actionLabel}
            </button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {items.map((item, index) => (
          <div
            key={`${item.session.id}-${item.actionLabel}`}
            className="flex items-center gap-3 rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-3 py-2.5"
          >
            <div className="w-5 shrink-0 text-center text-[10px] font-bold text-[var(--color-text-tertiary)]">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <a
                  href={`/sessions/${encodeURIComponent(item.session.id)}`}
                  className="font-[var(--font-mono)] text-[11px] text-[var(--color-accent)] hover:no-underline"
                >
                  {item.session.id}
                </a>
                <span className="rounded-full border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  {item.title}
                </span>
              </div>
              <p className="mt-1 truncate text-[12px] text-[var(--color-text-secondary)]">{item.note}</p>
            </div>
            <button
              onClick={() => void handleAction(item)}
              disabled={pending === item.session.id}
              className="rounded-[5px] border border-[rgba(88,166,255,0.28)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--color-accent)] transition-colors hover:bg-[rgba(88,166,255,0.08)] disabled:opacity-50"
            >
              {pending === item.session.id ? "sending..." : item.actionLabel}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function buildQueueItems(sessions: DashboardSession[]): QueueItem[] {
  const items: QueueItem[] = [];

  for (const session of sessions) {
    const level = getAttentionLevel(session);
    if (level === "merge" && session.pr) {
      items.push({
        session,
        title: "merge ready",
        note: `PR #${session.pr.number} is approved and CI green.`,
        actionLabel: `Merge #${session.pr.number}`,
        actionKind: "merge",
        actionPayload: session.pr.number,
        priority: 0,
      });
      continue;
    }

    if (level === "respond") {
      items.push({
        session,
        title: "needs input",
        note: session.summary ?? "Session is blocked and waiting for operator input.",
        actionLabel: "Send unblock",
        actionKind: "send",
        actionPayload: buildRespondMessage(session),
        priority: 1,
      });
      continue;
    }

    if (level === "review" && session.pr) {
      items.push({
        session,
        title: "needs review",
        note: `PR #${session.pr.number} has failing CI, review requests, or conflicts.`,
        actionLabel: "Ask to fix",
        actionKind: "send",
        actionPayload: `Review PR ${session.pr.url} and resolve the highest-priority blocker first. Reply with the blocker you picked and the fix plan.`,
        priority: 2,
      });
      continue;
    }

    if (session.activity === "exited" || session.status === "killed") {
      items.push({
        session,
        title: "terminated",
        note: "Session exited unexpectedly and can be restored in-place.",
        actionLabel: "Restore",
        actionKind: "restore",
        actionPayload: session.id,
        priority: 3,
      });
    }
  }

  return items.sort((a, b) => a.priority - b.priority || a.session.id.localeCompare(b.session.id));
}

function buildRespondMessage(session: DashboardSession): string {
  if (session.pr) {
    return `You are blocked on ${session.pr.url}. State the blocker in one sentence, choose the next smallest fix, and continue only on that fix.`;
  }
  return "State the blocker in one sentence, choose the next smallest action, and continue only on that action.";
}
