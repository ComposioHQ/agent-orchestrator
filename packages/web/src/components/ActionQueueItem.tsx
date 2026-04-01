"use client";

import type { PortfolioActionItem } from "@/lib/types";

interface ActionQueueItemProps {
  item: PortfolioActionItem;
  isSelected: boolean;
  onClick: () => void;
}

export function ActionQueueItem({ item, isSelected, onClick }: ActionQueueItemProps) {
  const { session, projectName } = item;

  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
        isSelected
          ? "bg-[var(--color-bg-elevated)] ring-1 ring-[var(--color-accent)]"
          : "hover:bg-[var(--color-bg-elevated)]"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-[var(--color-text-primary)]">
            {session.id}
          </span>
          <span className="text-[11px] text-[var(--color-text-tertiary)]">
            {projectName}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-[var(--color-text-secondary)]">
          {session.summary || session.branch || session.issueId || "No details"}
        </div>
      </div>
      {session.pr && (
        <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
          #{session.pr.number}
        </span>
      )}
    </button>
  );
}
