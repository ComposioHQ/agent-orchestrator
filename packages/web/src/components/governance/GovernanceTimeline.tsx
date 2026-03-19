"use client";

import {
  getEventTypeLabel,
  getEventTypeColor,
  formatAddress,
  type GovernanceTimelineEvent,
} from "@/lib/governance-types";

interface GovernanceTimelineProps {
  events: GovernanceTimelineEvent[];
  onSelectProposal?: (proposalId: string) => void;
}

function EventIcon({ type }: { type: GovernanceTimelineEvent["type"] }) {
  const color = getEventTypeColor(type);
  switch (type) {
    case "proposal_created":
      return (
        <svg className="h-4 w-4" fill="none" stroke={color} strokeWidth="2" viewBox="0 0 24 24">
          <path d="M12 4v16m8-8H4" />
        </svg>
      );
    case "proposal_status_changed":
      return (
        <svg className="h-4 w-4" fill="none" stroke={color} strokeWidth="2" viewBox="0 0 24 24">
          <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      );
    case "vote_cast":
      return (
        <svg className="h-4 w-4" fill="none" stroke={color} strokeWidth="2" viewBox="0 0 24 24">
          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "policy_updated":
      return (
        <svg className="h-4 w-4" fill="none" stroke={color} strokeWidth="2" viewBox="0 0 24 24">
          <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
        </svg>
      );
    case "attestation_added":
      return (
        <svg className="h-4 w-4" fill="none" stroke={color} strokeWidth="2" viewBox="0 0 24 24">
          <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      );
    case "fork_created":
      return (
        <svg className="h-4 w-4" fill="none" stroke={color} strokeWidth="2" viewBox="0 0 24 24">
          <path d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      );
    case "execution_consumed":
      return (
        <svg className="h-4 w-4" fill="none" stroke={color} strokeWidth="2" viewBox="0 0 24 24">
          <path d="M5 13l4 4L19 7" />
        </svg>
      );
  }
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffHours < 1) {
    const diffMins = Math.floor(diffMs / (1000 * 60));
    return diffMins <= 1 ? "just now" : `${diffMins}m ago`;
  }
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function GovernanceTimeline({ events, onSelectProposal }: GovernanceTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="py-12 text-center text-[12px] text-[var(--color-text-muted)]">
        No governance events yet
      </div>
    );
  }

  return (
    <div className="gov-timeline relative">
      <div className="absolute left-[19px] top-0 bottom-0 w-px bg-[var(--color-border-subtle)]" />
      {events.map((event) => {
        const hasProposalLink = event.ref.proposalId && onSelectProposal;
        return (
          <div
            key={event.id}
            className="gov-timeline-item group relative flex gap-3 py-2.5 pl-0 pr-2"
          >
            <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)]">
              <EventIcon type={event.type} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center gap-2">
                <span
                  className="text-[10px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: getEventTypeColor(event.type) }}
                >
                  {getEventTypeLabel(event.type)}
                </span>
                <span className="text-[10px] text-[var(--color-text-tertiary)]">
                  {formatTimestamp(event.timestamp)}
                </span>
              </div>
              <p className="mt-0.5 text-[12px] text-[var(--color-text-primary)]">
                {event.summary}
              </p>
              <div className="mt-1 flex items-center gap-3 text-[10px] text-[var(--color-text-muted)]">
                <span className="font-mono">{formatAddress(event.actor)}</span>
                {event.txHash && (
                  <span className="font-mono opacity-60" title={event.txHash}>
                    tx:{event.txHash.slice(0, 10)}...
                  </span>
                )}
                {hasProposalLink && event.ref.proposalId && (
                  <button
                    onClick={() => onSelectProposal(event.ref.proposalId as string)}
                    className="text-[var(--color-accent)] hover:underline"
                  >
                    View Proposal
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
