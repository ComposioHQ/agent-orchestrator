"use client";

import { useState } from "react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { SessionCard } from "./SessionCard";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
}

const zoneConfig: Record<AttentionLevel, {
  label: string;
  description: string;
  color: string;
  defaultCollapsed: boolean;
}> = {
  urgent: {
    label: "URGENT",
    description: "Sessions needing human input",
    color: "var(--color-accent-red)",
    defaultCollapsed: false,
  },
  action: {
    label: "ACTION",
    description: "PRs ready to merge",
    color: "var(--color-accent-green)",
    defaultCollapsed: false,
  },
  warning: {
    label: "WARNING",
    description: "Needs review or pending checks",
    color: "var(--color-accent-yellow)",
    defaultCollapsed: false,
  },
  ok: {
    label: "WORKING",
    description: "Sessions working normally",
    color: "var(--color-accent-blue)",
    defaultCollapsed: true,
  },
  done: {
    label: "COMPLETED",
    description: "Merged or terminated sessions",
    color: "var(--color-text-muted)",
    defaultCollapsed: true,
  },
};

export function AttentionZone({ level, sessions, onSend, onKill, onMerge }: AttentionZoneProps) {
  const config = zoneConfig[level];
  const [collapsed, setCollapsed] = useState(config.defaultCollapsed);

  if (sessions.length === 0) return null;

  return (
    <div className="mb-6">
      <button
        className="mb-2 flex w-full items-center gap-3 px-1 text-left"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span
          className="text-xs font-bold uppercase tracking-widest"
          style={{ color: config.color }}
        >
          {config.label}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {config.description}
        </span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 text-xs font-bold"
          style={{ color: config.color, background: `color-mix(in srgb, ${config.color} 10%, transparent)` }}
        >
          {sessions.length}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {collapsed ? "\u25B6" : "\u25BC"}
        </span>
      </button>

      {!collapsed && (
        <div className="space-y-2">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onSend={onSend}
              onKill={onKill}
              onMerge={onMerge}
            />
          ))}
        </div>
      )}
    </div>
  );
}
