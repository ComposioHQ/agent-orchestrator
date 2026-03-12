"use client";

import type { SessionHarnessContext } from "@/lib/types";

interface SessionHarnessPanelProps {
  harness: SessionHarnessContext | null | undefined;
}

const ACTION_LABELS: Record<string, string> = {
  operator_review: "review",
  escalate: "escalate",
  retry: "retry",
  reconcile_session: "reconcile",
  dispatch: "dispatch",
  monitor: "monitor",
  terminal: "terminal",
};

export function SessionHarnessPanel({ harness }: SessionHarnessPanelProps) {
  if (!harness) return null;

  const work = harness.workState;
  const reconcile = harness.reconciliation;
  const plan = harness.dispatchPlan;

  return (
    <section className="mb-6 rounded-[8px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Work Authority
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
            Repo-owned work and reconciliation state for this session.
          </p>
        </div>
        <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-accent)]">
          {harness.workId}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <AuthorityCard
          label="Work State"
          primary={work?.work_status ?? "untracked"}
          secondary={
            work
              ? `retry ${work.retry_count ?? 0}/${work.retry_budget ?? "∞"}`
              : "no persisted work state"
          }
        />
        <AuthorityCard
          label="Reconciliation"
          primary={labelForAction(reconcile?.next_action ?? "none")}
          secondary={reconcile?.reason ?? "no reconciliation action pending"}
        />
        <AuthorityCard
          label="Dispatch Plan"
          primary={labelForAction(plan?.next_action ?? "none")}
          secondary={plan ? `priority ${plan.priority}` : "not currently queued"}
        />
      </div>
    </section>
  );
}

function AuthorityCard({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary: string;
}) {
  return (
    <div className="rounded-[7px] border border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] p-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1 text-[13px] font-semibold text-[var(--color-text-primary)]">
        {primary}
      </div>
      <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">{secondary}</p>
    </div>
  );
}

function labelForAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replaceAll("_", " ");
}
