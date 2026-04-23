"use client";

import type { ProjectInfo } from "@/lib/project-name";
import { getAttentionLevel, type AttentionLevel, type DashboardSession } from "@/lib/types";

export interface ProjectSidebarProps {
  projects: ProjectInfo[];
  sessions: DashboardSession[] | null;
  activeProjectId: string | undefined;
  activeSessionId: string | undefined;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onMobileClose?: () => void;
}

export const SHOW_SESSION_ID_KEY = "ao:sidebar:show-session-id";

export function loadShowSessionId(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SHOW_SESSION_ID_KEY) === "true";
  } catch {
    return false;
  }
}

export const LEVEL_LABELS: Record<AttentionLevel, string> = {
  working: "working",
  pending: "pending",
  review: "review",
  respond: "respond",
  action: "action",
  merge: "merge",
  done: "done",
};

export type ProjectHealth = "red" | "yellow" | "green" | "gray";

export interface ProjectStatusSummary {
  tone: AttentionLevel | "done";
  detail: string;
}

export function getProjectHealth(sessions: DashboardSession[]): ProjectHealth {
  if (sessions.some((session) => getAttentionLevel(session) === "respond")) {
    return "red";
  }
  if (sessions.some((session) => {
    const level = getAttentionLevel(session);
    return level === "review" || level === "pending" || level === "action";
  })) {
    return "yellow";
  }
  if (sessions.some((session) => getAttentionLevel(session) === "merge")) {
    return "green";
  }
  if (sessions.length > 0) {
    return "green";
  }
  return "gray";
}

export function getProjectStatusSummary(sessions: DashboardSession[]): ProjectStatusSummary {
  const counts = sessions.reduce<Record<AttentionLevel, number>>(
    (accumulator, session) => {
      const level = getAttentionLevel(session);
      accumulator[level] += 1;
      return accumulator;
    },
    {
      merge: 0,
      action: 0,
      respond: 0,
      review: 0,
      pending: 0,
      working: 0,
      done: 0,
    },
  );

  if (counts.respond > 0) return { tone: "respond", detail: `${counts.respond} need response` };
  if (counts.action > 0) return { tone: "action", detail: `${counts.action} need action` };
  if (counts.review > 0) return { tone: "review", detail: `${counts.review} need review` };
  if (counts.merge > 0) return { tone: "merge", detail: `${counts.merge} ready to merge` };
  if (counts.pending > 0) return { tone: "pending", detail: `${counts.pending} waiting` };
  if (counts.working > 0) return { tone: "working", detail: `${counts.working} active now` };
  return { tone: "done", detail: "No active sessions" };
}
