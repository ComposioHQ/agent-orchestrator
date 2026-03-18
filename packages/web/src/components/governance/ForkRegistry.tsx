"use client";

import type { Fork } from "@/lib/governance-types";
import { formatAddress } from "@/lib/governance-types";

interface ForkRegistryProps {
  forks: Fork[];
  selectedForkId: string | null;
  onSelectFork: (forkId: string | null) => void;
  onViewPolicy: (forkId: string) => void;
}

export function ForkRegistry({
  forks,
  selectedForkId,
  onSelectFork,
  onViewPolicy,
}: ForkRegistryProps) {
  if (forks.length === 0) {
    return (
      <div className="py-12 text-center text-[12px] text-[var(--color-text-muted)]">
        No forks registered on-chain
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSelectFork(null)}
          className={`rounded-[6px] px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
            selectedForkId === null
              ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          }`}
        >
          All Forks
        </button>
        {forks.map((fork) => (
          <button
            key={fork.id}
            onClick={() => onSelectFork(fork.id)}
            className={`rounded-[6px] px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
              selectedForkId === fork.id
                ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {fork.name}
          </button>
        ))}
      </div>

      {/* Fork cards */}
      <div className="grid gap-3 md:grid-cols-2">
        {forks
          .filter((f) => !selectedForkId || f.id === selectedForkId)
          .map((fork) => (
            <div
              key={fork.id}
              className="detail-card rounded-[10px] border border-[var(--color-border-default)] p-4"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                    {fork.name}
                  </h3>
                  <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-tertiary)]">
                    {formatAddress(fork.registryAddress)}
                  </div>
                </div>
                <button
                  onClick={() => onViewPolicy(fork.id)}
                  className="shrink-0 rounded-[6px] border border-[var(--color-border-default)] px-2.5 py-1.5 text-[10px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text-primary)]"
                >
                  View Policy
                </button>
              </div>

              {/* Stats */}
              <div className="mb-3 flex gap-4">
                <ForkStat label="Maintainers" value={fork.maintainerCount} />
                <ForkStat label="Proposals" value={fork.proposalCount} />
                <ForkStat label="Attestations" value={fork.attestationCount} />
              </div>

              {/* Maintainer list */}
              <div className="border-t border-[var(--color-border-subtle)] pt-3">
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  Maintainers
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {fork.maintainers.map((addr) => (
                    <span
                      key={addr}
                      className="rounded-full bg-[var(--color-bg-subtle)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]"
                    >
                      {formatAddress(addr)}
                    </span>
                  ))}
                </div>
              </div>

              {/* Policy summary */}
              <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-3">
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  Policy
                </div>
                <div className="flex gap-4 text-[11px]">
                  <span className="text-[var(--color-text-secondary)]">
                    Quorum:{" "}
                    <span className="text-[var(--color-text-primary)]">
                      {fork.policy.quorum / 100}%
                    </span>
                  </span>
                  <span className="text-[var(--color-text-secondary)]">
                    Threshold:{" "}
                    <span className="text-[var(--color-text-primary)]">
                      {fork.policy.threshold}
                    </span>
                  </span>
                  <span className="text-[var(--color-text-secondary)]">
                    Gates:{" "}
                    <span className="text-[var(--color-text-primary)]">
                      {fork.policy.consentGates.filter((g) => g.requiresApproval).length}
                    </span>
                  </span>
                </div>
              </div>

              {/* Activity */}
              <div className="mt-2 text-[10px] text-[var(--color-text-tertiary)]">
                Created {new Date(fork.createdAt).toLocaleDateString()} · Last activity{" "}
                {new Date(fork.lastActivityAt).toLocaleDateString()}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function ForkStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="text-[16px] font-semibold tabular-nums text-[var(--color-text-primary)]">
        {value}
      </div>
    </div>
  );
}
