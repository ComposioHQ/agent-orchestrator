"use client";

import { useState } from "react";
import type { PortfolioActionItem } from "@/lib/types";
import { ActionItemRow } from "./ActionItemRow";

interface ActionItemsListProps {
  items: PortfolioActionItem[];
  onSend: (sessionId: string, message: string) => Promise<void>;
  onKill: (sessionId: string) => Promise<void>;
  onMerge: (prNumber: number) => Promise<void>;
  defaultExpanded?: boolean;
}

export function ActionItemsList({
  items,
  onSend,
  onKill,
  onMerge,
  defaultExpanded = true,
}: ActionItemsListProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (items.length === 0) return null;

  return (
    <section className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-5 py-3"
        style={{ minHeight: 44 }}
      >
        <svg
          className={`h-3 w-3 text-[var(--color-text-tertiary)] transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
          Action Items
        </span>
        <span className="text-[10px] font-semibold tabular-nums text-[var(--color-accent)]">
          {items.length}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--color-border-subtle)]">
          {items.map((item) => (
            <ActionItemRow
              key={item.session.id}
              item={item}
              onSend={onSend}
              onKill={onKill}
              onMerge={onMerge}
            />
          ))}
        </div>
      )}
    </section>
  );
}
