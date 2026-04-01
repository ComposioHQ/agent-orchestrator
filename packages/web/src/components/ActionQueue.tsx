"use client";

import type { PortfolioActionItem, AttentionLevel } from "@/lib/types";
import { ActionQueueItem } from "./ActionQueueItem";

interface ActionQueueProps {
  items: PortfolioActionItem[];
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
}

const LEVEL_LABELS: Record<AttentionLevel, string> = {
  respond: "Needs your input",
  review: "Needs investigation",
  merge: "Ready to merge",
  pending: "Waiting on others",
  working: "Agents running",
  done: "Completed",
};

export function ActionQueue({ items, selectedItemId, onSelectItem }: ActionQueueProps) {
  // Group by attention level
  const groups = new Map<AttentionLevel, PortfolioActionItem[]>();
  for (const item of items) {
    const existing = groups.get(item.attentionLevel) || [];
    existing.push(item);
    groups.set(item.attentionLevel, existing);
  }

  const orderedLevels: AttentionLevel[] = ["respond", "review", "merge", "pending", "working", "done"];

  return (
    <div className="p-4">
      {orderedLevels.map((level) => {
        const groupItems = groups.get(level);
        if (!groupItems || groupItems.length === 0) return null;

        return (
          <div key={level} className="mb-6">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
              {LEVEL_LABELS[level]} ({groupItems.length})
            </h3>
            <div className="space-y-1">
              {groupItems.map((item) => (
                <ActionQueueItem
                  key={item.session.id}
                  item={item}
                  isSelected={selectedItemId === item.session.id}
                  onClick={() => onSelectItem(item.session.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
