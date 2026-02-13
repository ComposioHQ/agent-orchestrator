"use client";

import type { DashboardSession } from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { PRStatus } from "./PRStatus";
import { CICheckList } from "./CIBadge";
import { Terminal } from "./Terminal";

interface SessionDetailProps {
  session: DashboardSession;
}

const activityLabel: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-accent-green)" },
  idle: { label: "Idle", color: "var(--color-text-muted)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-accent-yellow)" },
  blocked: { label: "Blocked", color: "var(--color-accent-red)" },
  exited: { label: "Exited", color: "var(--color-accent-red)" },
};

export function SessionDetail({ session }: SessionDetailProps) {
  const pr = session.pr;
  const level = getAttentionLevel(session);
  const activity = activityLabel[session.activity] ?? { label: session.activity, color: "var(--color-text-muted)" };

  return (
    <div className="mx-auto max-w-[900px] px-8 py-8">
      {/* Back link */}
      <a
        href="/"
        className="mb-6 inline-flex items-center gap-1 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-accent-blue)]"
      >
        &larr; Back to dashboard
      </a>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{session.id}</h1>
          <span
            className="rounded-full px-2 py-0.5 text-xs font-semibold"
            style={{
              color: activity.color,
              background: `color-mix(in srgb, ${activity.color} 15%, transparent)`,
            }}
          >
            {activity.label}
          </span>
          <span
            className="rounded-full px-2 py-0.5 text-xs font-semibold uppercase"
            style={{
              color: levelColor(level),
              background: `color-mix(in srgb, ${levelColor(level)} 10%, transparent)`,
            }}
          >
            {level}
          </span>
        </div>
        {session.summary && (
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{session.summary}</p>
        )}
      </div>

      {/* Info grid */}
      <div className="mb-8 grid grid-cols-2 gap-6">
        <InfoCard label="Project" value={session.projectId} />
        <InfoCard label="Status" value={session.status} />
        <InfoCard label="Branch" value={session.branch ?? "—"} mono />
        <InfoCard label="Issue" value={session.issueId ?? "—"} />
        <InfoCard label="Created" value={new Date(session.createdAt).toLocaleString()} />
        <InfoCard label="Last Activity" value={new Date(session.lastActivityAt).toLocaleString()} />
      </div>

      {/* PR Section */}
      {pr && (
        <Section title="Pull Request">
          <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-4">
            <div className="mb-3">
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-base font-medium hover:underline"
              >
                {pr.title}
              </a>
            </div>
            <PRStatus pr={pr} />

            {/* Merge readiness */}
            <div className="mt-4 border-t border-[var(--color-border-muted)] pt-3">
              <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Merge Readiness
              </h4>
              <div className="grid grid-cols-2 gap-2">
                <ReadinessItem label="CI Passing" ok={pr.mergeability.ciPassing} />
                <ReadinessItem label="Approved" ok={pr.mergeability.approved} />
                <ReadinessItem label="No Conflicts" ok={pr.mergeability.noConflicts} />
                <ReadinessItem label="Mergeable" ok={pr.mergeability.mergeable} />
              </div>
              {pr.mergeability.blockers.length > 0 && (
                <div className="mt-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Blockers:
                  </span>
                  <ul className="mt-1 list-inside list-disc text-xs text-[var(--color-accent-red)]">
                    {pr.mergeability.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* CI Checks */}
            {pr.ciChecks.length > 0 && (
              <div className="mt-4 border-t border-[var(--color-border-muted)] pt-3">
                <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  CI Checks
                </h4>
                <CICheckList checks={pr.ciChecks} />
              </div>
            )}

            {/* Unresolved Comments */}
            {pr.unresolvedComments.length > 0 && (
              <div className="mt-4 border-t border-[var(--color-border-muted)] pt-3">
                <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Unresolved Comments ({pr.unresolvedThreads})
                </h4>
                <div className="space-y-2">
                  {pr.unresolvedComments.map((c) => (
                    <div
                      key={c.url}
                      className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-bg-primary)] p-3"
                    >
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold text-[var(--color-text-secondary)]">
                          {c.author}
                        </span>
                        <span className="text-[var(--color-text-muted)]">on</span>
                        <span className="font-[var(--font-mono)] text-[var(--color-text-muted)]">
                          {c.path}
                        </span>
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto text-[11px] text-[var(--color-accent-blue)] hover:underline"
                        >
                          view
                        </a>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                        {c.body}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Terminal */}
      <Section title="Terminal">
        <Terminal sessionId={session.id} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function InfoCard({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 text-sm ${mono ? "font-[var(--font-mono)]" : ""} text-[var(--color-text-primary)]`}
      >
        {value}
      </div>
    </div>
  );
}

function ReadinessItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span style={{ color: ok ? "var(--color-accent-green)" : "var(--color-accent-red)" }}>
        {ok ? "\u2713" : "\u2717"}
      </span>
      <span className="text-[var(--color-text-secondary)]">{label}</span>
    </div>
  );
}

function levelColor(level: string): string {
  switch (level) {
    case "urgent": return "var(--color-accent-red)";
    case "action": return "var(--color-accent-green)";
    case "warning": return "var(--color-accent-yellow)";
    case "ok": return "var(--color-accent-blue)";
    default: return "var(--color-text-muted)";
  }
}
