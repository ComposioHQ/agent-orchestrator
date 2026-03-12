"use client";

import type { DispatchPlanItem, ReconciliationItem, WorkStateItem } from "@/lib/types";

interface HarnessPlanPanelProps {
  items: DispatchPlanItem[];
  workState?: WorkStateItem[];
  reconciliationState?: ReconciliationItem[];
}

const ACTION_LABELS: Record<string, string> = {
  operator_review: "review",
  escalate: "escalate",
  retry: "retry",
  reconcile_session: "reconcile",
  dispatch: "dispatch",
  monitor: "monitor",
};

export function HarnessPlanPanel({
  items,
  workState = [],
  reconciliationState = [],
}: HarnessPlanPanelProps) {
  if (items.length === 0) {
    return null;
  }

  const visibleItems = items.slice(0, 6);
  const focus = visibleItems[0];

  return (
    <section className="mb-7 rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Harness Plan
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
            Repo-derived next actions from `project-os`, shown before runtime intervention.
          </p>
        </div>
        <span className="rounded-full border border-[var(--color-border-subtle)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">
          {items.length} planned
        </span>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <SummaryPill label="tracked work" value={workState.length} />
        <SummaryPill
          label="needs reconcile"
          value={reconciliationState.filter((entry) => entry.next_action !== "monitor").length}
        />
      </div>

      <div className="mb-3 rounded-[7px] border border-[rgba(16,185,129,0.18)] bg-[linear-gradient(135deg,rgba(16,185,129,0.10),rgba(16,185,129,0.03))] p-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[rgb(16,185,129)]">
          Focus Work
        </div>
        <div className="mt-1 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-[var(--font-mono)] text-[13px] font-semibold text-[var(--color-text-primary)]">
              {focus.work_id}
            </div>
            <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">{focus.reason}</p>
          </div>
          <div className="rounded-full border border-[rgba(16,185,129,0.25)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[rgb(16,185,129)]">
            {labelForAction(focus.next_action)}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {visibleItems.map((item, index) => (
          <div
            key={`${item.work_id}-${item.next_action}`}
            className="flex items-center gap-3 rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] px-3 py-2.5"
          >
            <div className="w-5 shrink-0 text-center text-[10px] font-bold text-[var(--color-text-tertiary)]">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-accent)]">
                  {item.work_id}
                </span>
                <span className="rounded-full border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  {item.work_status}
                </span>
              </div>
              <p className="mt-1 truncate text-[12px] text-[var(--color-text-secondary)]">{item.reason}</p>
            </div>
            <div className="rounded-[5px] border border-[rgba(88,166,255,0.28)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--color-accent)]">
              {labelForAction(item.next_action)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SummaryPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-full border border-[var(--color-border-subtle)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-muted)]">
      {value} {label}
    </span>
  );
}

function labelForAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replaceAll("_", " ");
}
