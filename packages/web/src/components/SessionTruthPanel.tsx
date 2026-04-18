"use client";

import {
  getActivitySignalLabel,
  getActivitySignalReasonLabel,
  getLifecycleEvidence,
  getLifecycleGuidance,
  getPRTruthLabel,
  getPRTruthReasonLabel,
  getRuntimeTruthLabel,
  getRuntimeTruthReasonLabel,
  getSessionTruthLabel,
  getSessionTruthReasonLabel,
  type DashboardSession,
} from "@/lib/types";

function getActivityFactToneClass(session: DashboardSession): string {
  if (!session.activitySignal || session.activitySignal.state !== "valid") {
    return "text-[var(--color-text-secondary)]";
  }

  switch (session.activitySignal.activity) {
    case "active":
      return "text-[var(--color-status-working)]";
    case "ready":
      return "text-[var(--color-status-ready)]";
    case "idle":
      return "text-[var(--color-status-idle)]";
    case "waiting_input":
      return "text-[var(--color-status-attention)]";
    case "blocked":
    case "exited":
      return "text-[var(--color-status-error)]";
    default:
      return "text-[var(--color-text-secondary)]";
  }
}

function getSessionFactToneClass(session: DashboardSession): string {
  switch (session.lifecycle?.session.state) {
    case "detecting":
    case "needs_input":
    case "stuck":
      return "text-[var(--color-status-attention)]";
    case "terminated":
      return "text-[var(--color-status-error)]";
    case "done":
      return "text-[var(--color-status-ready)]";
    case "working":
      return "text-[var(--color-status-working)]";
    case "idle":
      return "text-[var(--color-status-pending)]";
    default:
      return "text-[var(--color-text-secondary)]";
  }
}

function getPrFactToneClass(session: DashboardSession): string {
  switch (session.lifecycle?.pr.state) {
    case "merged":
      return "text-[var(--color-status-ready)]";
    case "closed":
      return "text-[var(--color-status-error)]";
    case "open":
      return "text-[var(--color-accent)]";
    default:
      return "text-[var(--color-text-secondary)]";
  }
}

function getRuntimeFactToneClass(session: DashboardSession): string {
  switch (session.lifecycle?.runtime.state) {
    case "alive":
      return "text-[var(--color-status-ready)]";
    case "probe_failed":
      return "text-[var(--color-status-attention)]";
    case "missing":
    case "exited":
      return "text-[var(--color-status-error)]";
    default:
      return "text-[var(--color-text-secondary)]";
  }
}

export function SessionTruthPanel({ session }: { session: DashboardSession }) {
  if (!session.lifecycle) return null;

  const facts = [
    {
      heading: "Activity",
      label: getActivitySignalLabel(session),
      reason: getActivitySignalReasonLabel(session),
      toneClassName: getActivityFactToneClass(session),
    },
    {
      heading: "Session",
      label: getSessionTruthLabel(session),
      reason: getSessionTruthReasonLabel(session),
      toneClassName: getSessionFactToneClass(session),
    },
    {
      heading: "PR",
      label: getPRTruthLabel(session),
      reason: getPRTruthReasonLabel(session),
      toneClassName: getPrFactToneClass(session),
    },
    {
      heading: "Runtime",
      label: getRuntimeTruthLabel(session),
      reason: getRuntimeTruthReasonLabel(session),
      toneClassName: getRuntimeFactToneClass(session),
    },
  ];
  const guidance = getLifecycleGuidance(session);
  const evidence = getLifecycleEvidence(session);

  return (
    <section className="mb-4 rounded-[20px] border border-[var(--color-border-muted)] bg-[var(--color-bg-panel)] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
        Lifecycle Truth
      </p>
      <p className="mt-1 text-[13px] text-[var(--color-text-secondary)]">
        {session.lifecycle.summary}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {facts.map((fact) => (
          <div
            key={fact.heading}
            className="rounded-full border border-[var(--color-border-muted)] bg-[var(--color-bg-base)] px-3 py-1.5"
          >
            <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
              {fact.heading}
            </div>
            <div className={`mt-0.5 text-[12px] font-medium ${fact.toneClassName}`}>
              {fact.label}
            </div>
            {fact.reason ? (
              <div className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">
                {fact.reason}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {guidance ? (
        <p className="mt-3 text-[12px] text-[var(--color-status-attention)]">
          {guidance}
        </p>
      ) : null}
      {evidence ? (
        <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">
          Evidence: {evidence}
        </p>
      ) : null}
    </section>
  );
}
