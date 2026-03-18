"use client";

import { useEffect, useState } from "react";
import { type GovernancePolicy } from "@/lib/governance-types";

interface PolicyViewProps {
  forkId: string;
  onBack: () => void;
}

export function PolicyView({ forkId, onBack }: PolicyViewProps) {
  const [policy, setPolicy] = useState<GovernancePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/governance/forks/${encodeURIComponent(forkId)}/policy`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load policy");
        return res.json() as Promise<{ policy: GovernancePolicy }>;
      })
      .then((data) => {
        if (!controller.signal.aborted) setPolicy(data.policy);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPolicy(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [forkId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-accent)]" />
      </div>
    );
  }

  if (!policy) {
    return (
      <div className="py-12 text-center">
        <p className="text-[12px] text-[var(--color-status-error)]">Policy not found</p>
        <button onClick={onBack} className="mt-3 text-[11px] text-[var(--color-accent)] hover:underline">
          Back
        </button>
      </div>
    );
  }

  const hasPrevious = !!policy.previous;

  return (
    <div className="mx-auto max-w-[700px]">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" />
          </svg>
          Back to Fork Registry
        </button>
        {hasPrevious && (
          <button
            onClick={() => setShowDiff((v) => !v)}
            className={`rounded-[6px] border px-2.5 py-1.5 text-[10px] font-medium transition-colors ${
              showDiff
                ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                : "border-[var(--color-border-default)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {showDiff ? "Hide Diff" : "Show Policy Diff"}
          </button>
        )}
      </div>

      <div className="detail-card rounded-[10px] border border-[var(--color-border-default)] p-5">
        <h2 className="mb-1 text-[15px] font-semibold text-[var(--color-text-primary)]">
          Fork Policy
        </h2>
        <p className="mb-4 text-[11px] text-[var(--color-text-muted)]">
          Last updated {new Date(policy.updatedAt).toLocaleString()}
        </p>

        {/* Core parameters */}
        <div className="mb-5 grid grid-cols-2 gap-3">
          <PolicyParam
            label="Quorum"
            value={`${policy.quorum / 100}%`}
            previous={showDiff && policy.previous ? `${policy.previous.quorum / 100}%` : undefined}
          />
          <PolicyParam
            label="Threshold"
            value={policy.threshold}
            previous={showDiff && policy.previous ? policy.previous.threshold : undefined}
          />
        </div>

        {/* Consent gates */}
        <div className="mb-5">
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Consent Gates
          </h3>
          <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)]">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)]">
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Action
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Approval Required
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Min Approvals
                  </th>
                </tr>
              </thead>
              <tbody>
                {policy.consentGates.map((gate) => {
                  const prevGate = showDiff
                    ? policy.previous?.consentGates.find((g) => g.action === gate.action)
                    : undefined;
                  const isNew = showDiff && policy.previous && !prevGate;
                  return (
                    <tr
                      key={gate.action}
                      className={`border-b border-[var(--color-border-subtle)] last:border-0 ${
                        isNew ? "gov-diff-added" : ""
                      }`}
                    >
                      <td className="px-3 py-2 font-mono text-[11px] text-[var(--color-text-primary)]">
                        {gate.action}
                        {isNew && (
                          <span className="ml-1.5 text-[9px] font-bold uppercase text-[var(--color-status-ready)]">
                            NEW
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[11px]">
                        <DiffValue
                          current={gate.requiresApproval ? "Yes" : "No"}
                          previous={
                            showDiff && prevGate
                              ? prevGate.requiresApproval
                                ? "Yes"
                                : "No"
                              : undefined
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-[11px]">
                        <DiffValue
                          current={String(gate.minApprovals)}
                          previous={
                            showDiff && prevGate ? String(prevGate.minApprovals) : undefined
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
                {/* Show removed gates */}
                {showDiff &&
                  policy.previous?.consentGates
                    .filter((pg) => !policy.consentGates.find((g) => g.action === pg.action))
                    .map((removed) => (
                      <tr key={removed.action} className="gov-diff-removed border-b border-[var(--color-border-subtle)] last:border-0">
                        <td className="px-3 py-2 font-mono text-[11px] text-[var(--color-text-muted)] line-through">
                          {removed.action}
                          <span className="ml-1.5 text-[9px] font-bold uppercase text-[var(--color-status-error)]">
                            REMOVED
                          </span>
                        </td>
                        <td className="px-3 py-2 text-[11px] text-[var(--color-text-muted)] line-through">
                          {removed.requiresApproval ? "Yes" : "No"}
                        </td>
                        <td className="px-3 py-2 text-[11px] text-[var(--color-text-muted)] line-through">
                          {removed.minApprovals}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Maintainers */}
        <div>
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Maintainers ({policy.maintainers.length})
          </h3>
          <div className="space-y-1.5">
            {policy.maintainers.map((addr) => {
              const isNew =
                showDiff && policy.previous && !policy.previous.maintainers.includes(addr);
              return (
                <div
                  key={addr}
                  className={`flex items-center justify-between rounded-[6px] border border-[var(--color-border-subtle)] px-3 py-2 ${
                    isNew ? "gov-diff-added" : ""
                  }`}
                >
                  <span className="font-mono text-[11px] text-[var(--color-text-primary)]">
                    {addr}
                  </span>
                  {isNew && (
                    <span className="text-[9px] font-bold uppercase text-[var(--color-status-ready)]">
                      ADDED
                    </span>
                  )}
                </div>
              );
            })}
            {/* Show removed maintainers */}
            {showDiff &&
              policy.previous?.maintainers
                .filter((addr) => !policy.maintainers.includes(addr))
                .map((removed) => (
                  <div
                    key={removed}
                    className="gov-diff-removed flex items-center justify-between rounded-[6px] border border-[var(--color-border-subtle)] px-3 py-2"
                  >
                    <span className="font-mono text-[11px] text-[var(--color-text-muted)] line-through">
                      {removed}
                    </span>
                    <span className="text-[9px] font-bold uppercase text-[var(--color-status-error)]">
                      REMOVED
                    </span>
                  </div>
                ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PolicyParam({
  label,
  value,
  previous,
}: {
  label: string;
  value: string;
  previous?: string;
}) {
  const changed = previous !== undefined && previous !== value;
  return (
    <div className={`rounded-[8px] border border-[var(--color-border-subtle)] px-3 py-2.5 ${changed ? "gov-diff-changed" : ""}`}>
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        {changed && (
          <>
            <span className="text-[14px] text-[var(--color-status-error)] line-through">{previous}</span>
            <svg className="h-3 w-3 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </>
        )}
        <span className={`text-[14px] font-semibold ${changed ? "text-[var(--color-status-ready)]" : "text-[var(--color-text-primary)]"}`}>
          {value}
        </span>
      </div>
    </div>
  );
}

function DiffValue({ current, previous }: { current: string; previous?: string }) {
  if (previous === undefined || previous === current) {
    return <span className="text-[var(--color-text-primary)]">{current}</span>;
  }
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[var(--color-status-error)] line-through">{previous}</span>
      <svg className="h-2.5 w-2.5 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path d="M13 7l5 5m0 0l-5 5m5-5H6" />
      </svg>
      <span className="font-semibold text-[var(--color-status-ready)]">{current}</span>
    </span>
  );
}
