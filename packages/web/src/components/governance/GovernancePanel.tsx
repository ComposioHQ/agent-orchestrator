"use client";

import { useCallback, useState } from "react";
import { useGovernanceEvents } from "@/hooks/useGovernanceEvents";
import { useWalletConnect } from "@/hooks/useWalletConnect";
import { GovernanceTimeline } from "./GovernanceTimeline";
import { ProposalDetail } from "./ProposalDetail";
import { ForkRegistry } from "./ForkRegistry";
import { PolicyView } from "./PolicyView";
import { WalletButton } from "./WalletButton";
import { sortProposalsByStatus, getProposalStatusColor } from "@/lib/governance-types";
import type { VoteChoice, Proposal } from "@/lib/governance-types";
import { cn } from "@/lib/cn";

type GovernanceTab = "timeline" | "proposals" | "forks" | "policy";

interface SubView {
  type: "proposal" | "policy";
  id: string;
}

export function GovernancePanel() {
  const [activeTab, setActiveTab] = useState<GovernanceTab>("timeline");
  const [subView, setSubView] = useState<SubView | null>(null);
  const { state, selectFork } = useGovernanceEvents(null);
  const { wallet, connect, disconnect, signTransaction } = useWalletConnect();

  const handleSelectProposal = useCallback((proposalId: string) => {
    setSubView({ type: "proposal", id: proposalId });
    setActiveTab("proposals");
  }, []);

  const handleViewPolicy = useCallback((forkId: string) => {
    setSubView({ type: "policy", id: forkId });
    setActiveTab("policy");
  }, []);

  const handleBack = useCallback(() => {
    setSubView(null);
  }, []);

  const handleVote = useCallback(
    async (proposalId: string, choice: VoteChoice) => {
      if (!wallet.connected || !wallet.address) return;

      try {
        const txHash = await signTransaction({
          type: "vote",
          proposalId,
          choice,
        });

        const res = await fetch(`/api/governance/proposals/${encodeURIComponent(proposalId)}/vote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            choice,
            voter: wallet.address,
            txHash,
          }),
        });

        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? "Vote submission failed");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Vote failed";
        console.error(`[governance] Vote failed for ${proposalId}:`, message);
        throw err;
      }
    },
    [wallet.connected, wallet.address, signTransaction],
  );

  const TABS: { key: GovernanceTab; label: string }[] = [
    { key: "timeline", label: "Timeline" },
    { key: "proposals", label: "Proposals" },
    { key: "forks", label: "Fork Registry" },
    { key: "policy", label: "Policy" },
  ];

  const sortedProposals = sortProposalsByStatus(state.proposals);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="border-b border-[var(--color-border-subtle)] px-8 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <a
                href="/"
                className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:no-underline"
              >
                Dashboard
              </a>
              <svg className="h-3 w-3 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="m9 18 6-6-6-6" />
              </svg>
              <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)]">
                Governance
              </h1>
            </div>
            <GovernanceStats proposals={state.proposals} forkCount={state.forks.length} />
          </div>
          <WalletButton wallet={wallet} onConnect={connect} onDisconnect={disconnect} />
        </div>

        {/* Tabs */}
        <div className="mt-4 flex gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => {
                setActiveTab(tab.key);
                setSubView(null);
              }}
              className={cn(
                "rounded-t-[6px] px-3 py-2 text-[12px] font-medium transition-colors",
                activeTab === tab.key
                  ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {state.loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-border-default)] border-t-[var(--color-accent)]" />
          </div>
        ) : (
          <>
            {/* Timeline tab */}
            {activeTab === "timeline" && (
              <div className="mx-auto max-w-[700px]">
                <GovernanceTimeline
                  events={state.timeline}
                  onSelectProposal={handleSelectProposal}
                />
              </div>
            )}

            {/* Proposals tab */}
            {activeTab === "proposals" && !subView && (
              <div className="mx-auto max-w-[700px]">
                <ProposalList
                  proposals={sortedProposals}
                  onSelect={handleSelectProposal}
                />
              </div>
            )}

            {activeTab === "proposals" && subView?.type === "proposal" && (
              <ProposalDetail
                proposalId={subView.id}
                onBack={handleBack}
                walletAddress={wallet.address}
                onVote={wallet.connected ? handleVote : undefined}
              />
            )}

            {/* Fork Registry tab */}
            {activeTab === "forks" && (
              <ForkRegistry
                forks={state.forks}
                selectedForkId={state.selectedForkId}
                onSelectFork={selectFork}
                onViewPolicy={handleViewPolicy}
              />
            )}

            {/* Policy tab */}
            {activeTab === "policy" && subView?.type === "policy" && (
              <PolicyView forkId={subView.id} onBack={handleBack} />
            )}

            {activeTab === "policy" && !subView && (
              <div className="mx-auto max-w-[700px]">
                <div className="py-12 text-center text-[12px] text-[var(--color-text-muted)]">
                  Select a fork from the{" "}
                  <button
                    onClick={() => setActiveTab("forks")}
                    className="text-[var(--color-accent)] hover:underline"
                  >
                    Fork Registry
                  </button>{" "}
                  to view its policy.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GovernanceStats({
  proposals,
  forkCount,
}: {
  proposals: Proposal[];
  forkCount: number;
}) {
  const active = proposals.filter((p) => p.status === "active").length;
  const approved = proposals.filter((p) => p.status === "approved").length;

  if (proposals.length === 0 && forkCount === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no governance data</span>;
  }

  return (
    <div className="flex items-baseline gap-0.5">
      <span className="flex items-baseline">
        <span className="text-[20px] font-bold tabular-nums tracking-tight text-[var(--color-text-primary)]">
          {proposals.length}
        </span>
        <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">proposals</span>
      </span>
      {active > 0 && (
        <>
          <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">·</span>
          <span className="flex items-baseline">
            <span className="text-[20px] font-bold tabular-nums tracking-tight text-[var(--color-status-working)]">
              {active}
            </span>
            <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">active</span>
          </span>
        </>
      )}
      {approved > 0 && (
        <>
          <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">·</span>
          <span className="flex items-baseline">
            <span className="text-[20px] font-bold tabular-nums tracking-tight text-[var(--color-status-ready)]">
              {approved}
            </span>
            <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">approved</span>
          </span>
        </>
      )}
      <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">·</span>
      <span className="flex items-baseline">
        <span className="text-[20px] font-bold tabular-nums tracking-tight text-[var(--color-text-primary)]">
          {forkCount}
        </span>
        <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">forks</span>
      </span>
    </div>
  );
}

function ProposalList({
  proposals,
  onSelect,
}: {
  proposals: Proposal[];
  onSelect: (id: string) => void;
}) {
  if (proposals.length === 0) {
    return (
      <div className="py-12 text-center text-[12px] text-[var(--color-text-muted)]">
        No proposals yet
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {proposals.map((proposal) => (
        <button
          key={proposal.id}
          onClick={() => onSelect(proposal.id)}
          className="group w-full rounded-[8px] border border-[var(--color-border-default)] p-3.5 text-left transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-elevated)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)] group-hover:text-[var(--color-accent)]">
                {proposal.title}
              </h3>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                <span className="font-mono">{proposal.id}</span>
                <span>·</span>
                <span>{new Date(proposal.createdAt).toLocaleDateString()}</span>
                <span>·</span>
                <span>
                  {proposal.votes.for + proposal.votes.against + proposal.votes.abstain} votes
                </span>
              </div>
            </div>
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.06em]"
              style={{
                color: getProposalStatusColor(proposal.status),
                background: `color-mix(in srgb, ${getProposalStatusColor(proposal.status)} 12%, transparent)`,
              }}
            >
              {proposal.status}
            </span>
          </div>
          {/* Mini vote bar */}
          <div className="mt-2 flex h-1 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]">
            {proposal.votes.for > 0 && (
              <div
                className="h-full bg-[var(--color-status-ready)]"
                style={{
                  width: `${(proposal.votes.for / Math.max(proposal.votes.for + proposal.votes.against + proposal.votes.abstain, 1)) * 100}%`,
                }}
              />
            )}
            {proposal.votes.against > 0 && (
              <div
                className="h-full bg-[var(--color-status-error)]"
                style={{
                  width: `${(proposal.votes.against / Math.max(proposal.votes.for + proposal.votes.against + proposal.votes.abstain, 1)) * 100}%`,
                }}
              />
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
