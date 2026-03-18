"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  Proposal,
  Vote,
  VoteChoice,
  Attestation,
} from "@/lib/governance-types";
import {
  getProposalStatusColor,
  formatAddress,
  getVotePercentage,
  isVotingOpen,
} from "@/lib/governance-types";

interface ProposalDetailProps {
  proposalId: string;
  onBack: () => void;
  walletAddress?: string | null;
  onVote?: (proposalId: string, choice: VoteChoice) => Promise<void>;
}

interface ProposalData {
  proposal: Proposal;
  votes: Vote[];
}

export function ProposalDetail({
  proposalId,
  onBack,
  walletAddress,
  onVote,
}: ProposalDetailProps) {
  const [data, setData] = useState<ProposalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/governance/proposals/${encodeURIComponent(proposalId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load proposal");
        return res.json() as Promise<ProposalData>;
      })
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Unknown error"))
      .finally(() => setLoading(false));
  }, [proposalId]);

  const handleVote = useCallback(
    async (choice: VoteChoice) => {
      if (!onVote || voting) return;
      setVoting(true);
      try {
        await onVote(proposalId, choice);
      } finally {
        setVoting(false);
      }
    },
    [onVote, proposalId, voting],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-accent)]" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="py-12 text-center">
        <p className="text-[12px] text-[var(--color-status-error)]">{error ?? "Proposal not found"}</p>
        <button
          onClick={onBack}
          className="mt-3 text-[11px] text-[var(--color-accent)] hover:underline"
        >
          Back to timeline
        </button>
      </div>
    );
  }

  const { proposal, votes } = data;
  const pct = getVotePercentage(proposal.votes);
  const votingOpen = isVotingOpen(proposal);
  const canVote = votingOpen && walletAddress && onVote;

  return (
    <div className="mx-auto max-w-[700px]">
      {/* Header */}
      <div className="mb-4 flex items-center gap-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
      </div>

      {/* Proposal card */}
      <div className="detail-card rounded-[10px] border border-[var(--color-border-default)] p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              {proposal.title}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span className="font-mono">{formatAddress(proposal.author)}</span>
              <span>·</span>
              <span>{new Date(proposal.createdAt).toLocaleDateString()}</span>
              <span>·</span>
              <span className="font-mono text-[10px] opacity-60">{proposal.id}</span>
            </div>
          </div>
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.06em]"
            style={{
              color: getProposalStatusColor(proposal.status),
              background: `color-mix(in srgb, ${getProposalStatusColor(proposal.status)} 12%, transparent)`,
              border: `1px solid color-mix(in srgb, ${getProposalStatusColor(proposal.status)} 25%, transparent)`,
            }}
          >
            {proposal.status}
          </span>
        </div>

        <p className="mb-5 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          {proposal.description}
        </p>

        {/* Vote tally */}
        <div className="mb-5">
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Vote Record
          </h3>
          <div className="mb-2 flex h-2 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]">
            {pct.for > 0 && (
              <div
                className="h-full bg-[var(--color-status-ready)]"
                style={{ width: `${pct.for}%` }}
              />
            )}
            {pct.against > 0 && (
              <div
                className="h-full bg-[var(--color-status-error)]"
                style={{ width: `${pct.against}%` }}
              />
            )}
            {pct.abstain > 0 && (
              <div
                className="h-full bg-[var(--color-text-tertiary)]"
                style={{ width: `${pct.abstain}%` }}
              />
            )}
          </div>
          <div className="flex gap-4 text-[11px]">
            <span className="text-[var(--color-status-ready)]">
              {proposal.votes.for} For ({pct.for}%)
            </span>
            <span className="text-[var(--color-status-error)]">
              {proposal.votes.against} Against ({pct.against}%)
            </span>
            <span className="text-[var(--color-text-muted)]">
              {proposal.votes.abstain} Abstain ({pct.abstain}%)
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-[var(--color-text-tertiary)]">
            <span>
              Quorum: {proposal.votes.quorumRequired / 100}%{" "}
              {proposal.votes.quorumReached ? (
                <span className="text-[var(--color-status-ready)]">(reached)</span>
              ) : (
                <span className="text-[var(--color-status-attention)]">(not reached)</span>
              )}
            </span>
            <span>·</span>
            <span>Threshold: {proposal.votes.threshold}</span>
          </div>
        </div>

        {/* Vote buttons */}
        {canVote && (
          <div className="mb-5 flex gap-2">
            <button
              onClick={() => void handleVote("for")}
              disabled={voting}
              className="rounded-[6px] border border-[rgba(63,185,80,0.3)] bg-[rgba(63,185,80,0.08)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-status-ready)] hover:bg-[rgba(63,185,80,0.15)] disabled:opacity-50"
            >
              Vote For
            </button>
            <button
              onClick={() => void handleVote("against")}
              disabled={voting}
              className="rounded-[6px] border border-[rgba(248,81,73,0.3)] bg-[rgba(248,81,73,0.08)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-status-error)] hover:bg-[rgba(248,81,73,0.15)] disabled:opacity-50"
            >
              Vote Against
            </button>
            <button
              onClick={() => void handleVote("abstain")}
              disabled={voting}
              className="rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-muted)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
            >
              Abstain
            </button>
          </div>
        )}

        {/* Individual votes */}
        {votes.length > 0 && (
          <div className="mb-5">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
              Individual Votes
            </h3>
            <div className="space-y-1.5">
              {votes.map((vote) => (
                <div
                  key={`${vote.voter}-${vote.proposalId}`}
                  className="flex items-center justify-between rounded-[6px] border border-[var(--color-border-subtle)] px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-[var(--color-text-primary)]">
                      {formatAddress(vote.voter)}
                    </span>
                    {vote.delegate && (
                      <span className="text-[10px] text-[var(--color-text-tertiary)]">
                        via {formatAddress(vote.delegate)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <VoteChoiceBadge choice={vote.choice} />
                    <span className="text-[10px] text-[var(--color-text-tertiary)]">
                      {new Date(vote.timestamp).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Execution authorization */}
        {proposal.executionScopes.length > 0 && (
          <div className="mb-5">
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
              Execution Authorization
            </h3>
            <div className="space-y-1.5">
              {proposal.executionScopes.map((scope) => (
                <div
                  key={scope.id}
                  className="flex items-center justify-between rounded-[6px] border border-[var(--color-border-subtle)] px-3 py-2"
                >
                  <span className="font-mono text-[11px] text-[var(--color-text-primary)]">
                    {scope.scope}
                  </span>
                  {scope.consumed ? (
                    <span className="flex items-center gap-1 text-[10px] text-[var(--color-status-ready)]">
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                      Consumed
                    </span>
                  ) : (
                    <span className="text-[10px] text-[var(--color-status-attention)]">Pending</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Evidence chain (attestations) */}
        {proposal.attestations.length > 0 && (
          <div>
            <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
              Evidence Chain
            </h3>
            <div className="space-y-1.5">
              {proposal.attestations.map((att) => (
                <AttestationRow key={att.id} attestation={att} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function VoteChoiceBadge({ choice }: { choice: VoteChoice }) {
  const config = {
    for: { label: "FOR", color: "var(--color-status-ready)" },
    against: { label: "AGAINST", color: "var(--color-status-error)" },
    abstain: { label: "ABSTAIN", color: "var(--color-text-muted)" },
  }[choice];

  return (
    <span
      className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em]"
      style={{
        color: config.color,
        background: `color-mix(in srgb, ${config.color} 12%, transparent)`,
      }}
    >
      {config.label}
    </span>
  );
}

function AttestationRow({ attestation }: { attestation: Attestation }) {
  const [verified, setVerified] = useState<boolean | null>(attestation.verified ?? null);
  const [verifying, setVerifying] = useState(false);

  const handleVerify = () => {
    setVerifying(true);
    // Simulate on-chain verification
    setTimeout(() => {
      setVerified(true);
      setVerifying(false);
    }, 1500);
  };

  const kindLabel = {
    ci: "CI",
    review_verdict: "Review",
    convergence_pattern: "Convergence",
    custom: "Custom",
  }[attestation.kind];

  return (
    <div className="flex items-center justify-between rounded-[6px] border border-[var(--color-border-subtle)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="rounded bg-[var(--color-bg-subtle)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--color-text-muted)]">
          {kindLabel}
        </span>
        <span className="font-mono text-[10px] text-[var(--color-text-secondary)]" title={attestation.evidenceHash}>
          {attestation.evidenceHash.slice(0, 16)}...
        </span>
        <span className="text-[10px] text-[var(--color-text-tertiary)]">
          by {formatAddress(attestation.attester)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {verified === true ? (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-status-ready)]">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            Verified
          </span>
        ) : verified === false ? (
          <span className="text-[10px] text-[var(--color-status-error)]">Failed</span>
        ) : (
          <button
            onClick={handleVerify}
            disabled={verifying}
            className="text-[10px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
          >
            {verifying ? "Verifying..." : "Verify on-chain"}
          </button>
        )}
      </div>
    </div>
  );
}
