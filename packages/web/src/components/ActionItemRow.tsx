"use client";

import { useState, useCallback } from "react";
import type { PortfolioActionItem, AttentionLevel } from "@/lib/types";
import { InlineMessageInput } from "./InlineMessageInput";

interface ActionItemRowProps {
  item: PortfolioActionItem;
  onSend: (sessionId: string, message: string) => Promise<void>;
  onKill: (sessionId: string) => Promise<void>;
  onMerge: (prNumber: number) => Promise<void>;
}

const LEVEL_STYLES: Record<AttentionLevel, { tone: string; tint: string }> = {
  respond: { tone: "var(--color-status-error)", tint: "var(--color-tint-red)" },
  review: { tone: "var(--color-accent-orange)", tint: "var(--color-tint-orange)" },
  merge: { tone: "var(--color-status-ready)", tint: "var(--color-tint-green)" },
  pending: { tone: "var(--color-status-attention)", tint: "var(--color-tint-yellow)" },
  working: { tone: "var(--color-status-working)", tint: "var(--color-tint-blue)" },
  done: { tone: "var(--color-text-tertiary)", tint: "var(--color-tint-neutral)" },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getStatusText(level: AttentionLevel): string {
  switch (level) {
    case "respond": return "Needs input";
    case "review": return "Needs review";
    case "merge": return "Ready to merge";
    case "pending": return "Waiting";
    case "working": return "Working";
    case "done": return "Done";
  }
}

export function ActionItemRow({ item, onSend, onKill, onMerge }: ActionItemRowProps) {
  const [showInput, setShowInput] = useState(false);
  const [loadingAction, setLoadingAction] = useState<"send" | "merge" | "kill" | null>(null);
  const { session, projectId, projectName, attentionLevel } = item;
  const style = LEVEL_STYLES[attentionLevel];
  const isDone = attentionLevel === "done";
  const hasMergeablePR = attentionLevel === "merge" && session.pr !== null;
  const busy = loadingAction !== null;

  const handleSend = useCallback(
    async (sessionId: string, message: string) => {
      setLoadingAction("send");
      try {
        await onSend(sessionId, message);
        setShowInput(false);
      } catch {
        // Toast is shown by parent — keep input open for retry
      } finally {
        setLoadingAction(null);
      }
    },
    [onSend],
  );

  const handleCancel = useCallback(() => {
    setShowInput(false);
  }, []);

  const handleMergeClick = useCallback(async () => {
    setLoadingAction("merge");
    try {
      await onMerge(session.pr!.number);
    } catch {
      // Toast is shown by parent
    } finally {
      setLoadingAction(null);
    }
  }, [onMerge, session.pr]);

  const handleKillClick = useCallback(async () => {
    setLoadingAction("kill");
    try {
      await onKill(session.id);
    } catch {
      // Toast is shown by parent
    } finally {
      setLoadingAction(null);
    }
  }, [onKill, session.id]);

  return (
    <div className="group">
      <div
        className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-[var(--color-bg-elevated-hover)]"
        style={{ minHeight: 44 }}
      >
        {/* Status dot */}
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: style.tone }}
          aria-hidden="true"
        />

        {/* Session ID */}
        <a
          href={`/projects/${encodeURIComponent(projectId)}?session=${encodeURIComponent(session.id)}`}
          className="shrink-0 text-[12px] text-[var(--color-accent)] hover:underline"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {session.id.slice(0, 8)}
        </a>

        {/* Project badge */}
        <span className="shrink-0 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
          {projectName}
        </span>

        {/* Status text */}
        <span
          className="shrink-0 text-[12px] font-medium"
          style={{ color: style.tone }}
        >
          {getStatusText(attentionLevel)}
        </span>

        {/* Spacer */}
        <span className="flex-1" />

        {/* Time ago */}
        <span
          className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-tertiary)]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {timeAgo(session.lastActivityAt)}
        </span>

        {/* Action buttons */}
        <div className="flex shrink-0 items-center gap-1.5">
          {hasMergeablePR && (
            <button
              type="button"
              onClick={handleMergeClick}
              disabled={busy}
              className="border border-[var(--color-border-tint-green)] bg-[var(--color-tint-green)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-status-ready)] transition-colors hover:bg-[var(--color-border-tint-green-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ minHeight: 44, borderRadius: "2px" }}
            >
              {loadingAction === "merge" ? "Merging\u2026" : "Merge"}
            </button>
          )}

          {!isDone && (
            <button
              type="button"
              onClick={() => setShowInput((prev) => !prev)}
              disabled={busy}
              className="border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{ minHeight: 44, borderRadius: "2px" }}
            >
              Send
            </button>
          )}

          {!isDone && (
            <button
              type="button"
              onClick={handleKillClick}
              disabled={busy}
              className="border border-transparent px-2.5 py-1 text-[11px] font-medium text-[var(--color-status-error)] opacity-0 transition-all hover:border-[var(--color-border-tint-red)] hover:bg-[var(--color-tint-red)] group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ minHeight: 44, borderRadius: "2px" }}
            >
              {loadingAction === "kill" ? "Killing\u2026" : "Kill"}
            </button>
          )}
        </div>
      </div>

      {/* Inline message input */}
      {showInput && (
        <div className="border-t border-[var(--color-border-subtle)] px-5 py-3">
          <InlineMessageInput
            sessionId={session.id}
            onSend={handleSend}
            onCancel={handleCancel}
            placeholder={`Send a message to ${session.id.slice(0, 8)}...`}
          />
        </div>
      )}
    </div>
  );
}
