"use client";

import { useState } from "react";
import type { AttentionLevel } from "@/lib/types";

export const AGENT_DOT_COLORS: Record<AttentionLevel, string> = {
  working: "var(--color-status-working)",
  respond: "var(--color-status-attention)",
  review: "var(--color-accent-violet)",
  merge: "var(--color-status-ready)",
  pending: "var(--color-text-tertiary)",
  done: "var(--color-text-quaternary, var(--color-text-tertiary))",
};

export const ATTENTION_BORDER_CLASS: Record<AttentionLevel, string> = {
  working: "border-l-[var(--color-status-working)]",
  respond: "border-l-[var(--color-status-attention)]",
  review: "border-l-[var(--color-accent-violet)]",
  merge: "border-l-[var(--color-status-ready)]",
  pending: "border-l-[var(--color-border-subtle)]",
  done: "border-l-[var(--color-border-subtle)]",
};

const ATTENTION_STATUS_LABEL: Record<AttentionLevel, string> = {
  working: "working",
  respond: "waiting",
  review: "in review",
  merge: "mergeable",
  pending: "pending",
  done: "done",
};

export function formatAgentLabel(agentId: string | undefined): string {
  switch (agentId) {
    case "claude-code":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    default:
      return agentId
        ? agentId.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
        : "Agent";
  }
}

function getAgentIconProps(agentId: string | undefined): { src?: string; fallback: string } {
  switch (agentId) {
    case "claude-code":
      return { src: "/agent-icons/claude-code.png", fallback: "CC" };
    case "opencode":
      return { src: "/agent-icons/opencode.png", fallback: "OC" };
    case "codex":
      return { src: "/agent-icons/codex.svg", fallback: "CX" };
    default: {
      const fallback = formatAgentLabel(agentId)
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase() || "AG";
      return { fallback };
    }
  }
}

export function StatusChip({ attention }: { attention: AttentionLevel }) {
  if (attention === "pending" || attention === "done") return null;
  const color = AGENT_DOT_COLORS[attention];

  return (
    <span
      className="shrink-0 rounded-[3px] px-1 py-px text-[9px] font-semibold uppercase tracking-[0.055em]"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {ATTENTION_STATUS_LABEL[attention]}
    </span>
  );
}

export function ClockIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.75V12l2.75 1.75" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

export function SortIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
      <path d="M5 7h10M5 12h7M5 17h4" />
      <path d="m17 15 2 2 2-2" />
      <path d="M19 7v10" />
    </svg>
  );
}

export function FolderPlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
      <path d="M3.75 7.5A1.75 1.75 0 0 1 5.5 5.75h4.1l1.75 1.75h7.15A1.75 1.75 0 0 1 20.25 9.25v8A1.75 1.75 0 0 1 18.5 19H5.5a1.75 1.75 0 0 1-1.75-1.75V7.5Z" />
      <path d="M12 10.25v5.5M9.25 13h5.5" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 7h1a5 5 0 0 1 0 10h-1M9 17H8a5 5 0 0 1 0-10h1" />
      <path d="M8.5 12h7" />
    </svg>
  );
}

export function GripIcon() {
  return (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round">
      <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function SelectChevronIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="m8 10 4-4 4 4M16 14l-4 4-4-4" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
      <path d="m5 12 4.5 4.5L19 7" />
    </svg>
  );
}

export function ChevronLeftIcon() {
  return (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

export function ChevronRightIcon() {
  return (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function FolderOpenIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.75 7.5A1.75 1.75 0 0 1 5.5 5.75h4.1l1.75 1.75h7.15A1.75 1.75 0 0 1 20.25 9.25v.25" />
      <path d="M3.08 12.25a1.25 1.25 0 0 1 1.22-1h15.4a1.25 1.25 0 0 1 1.22 1.53l-1.5 6a1.25 1.25 0 0 1-1.22.97H5.5a1.75 1.75 0 0 1-1.75-1.75l-.67-5.75Z" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  );
}

export function StarIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

function AgentFaviconIconFallback({ fallback }: { fallback: string }) {
  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-slate-100 text-[9px] font-semibold tracking-[0.08em] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      {fallback}
    </span>
  );
}

export function AgentFaviconIcon({
  src,
  fallback,
}: {
  src: string;
  fallback: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <AgentFaviconIconFallback fallback={fallback} />;
  }

  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-[4px] bg-white ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-700/70">
      <img
        alt=""
        aria-hidden="true"
        className="h-full w-full object-cover"
        src={src}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

export function SidebarAgentIcon({
  agentId,
  attention,
}: {
  agentId: string | undefined;
  attention: AttentionLevel;
}) {
  const label = formatAgentLabel(agentId);
  const { src, fallback } = getAgentIconProps(agentId);
  const badgeColor = AGENT_DOT_COLORS[attention];
  const isAnimated = attention === "working";

  return (
    <span className="relative shrink-0" aria-label={`${label} agent`} title={label}>
      {src ? <AgentFaviconIcon src={src} fallback={fallback} /> : <AgentFaviconIconFallback fallback={fallback} />}
      <span className="absolute -bottom-px -right-px flex h-[7px] w-[7px] items-center justify-center rounded-full bg-[var(--color-bg-primary)] p-px">
        {isAnimated ? (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
            style={{ backgroundColor: badgeColor }}
          />
        ) : null}
        <span
          className="relative inline-flex h-full w-full rounded-full"
          style={{ backgroundColor: badgeColor }}
        />
      </span>
    </span>
  );
}
