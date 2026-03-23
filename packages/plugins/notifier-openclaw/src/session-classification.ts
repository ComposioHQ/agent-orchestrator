import type { AoSessionInfo } from "./commands.js";

export interface AoSessionStateCounts {
  total: number;
  active: number;
  degraded: number;
  dead: number;
}

export function classifySessionState(session: AoSessionInfo): "active" | "degraded" | "dead" | "other" {
  const status = (session.status ?? "").toLowerCase();
  const activity = (session.activity ?? "").toLowerCase();

  if (activity === "active" || status === "working") {
    return "active";
  }

  if (["killed", "dead", "crashed", "failed", "error"].includes(status)) {
    return "dead";
  }

  if (["blocked", "stuck", "unknown"].includes(status) || activity === "inactive") {
    return "degraded";
  }

  return "other";
}

export function summarizeSessionStates(sessions: AoSessionInfo[]): AoSessionStateCounts {
  let active = 0;
  let degraded = 0;
  let dead = 0;

  for (const session of sessions) {
    const classification = classifySessionState(session);
    if (classification === "active") {
      active += 1;
      continue;
    }
    if (classification === "dead") {
      dead += 1;
      continue;
    }
    if (classification === "degraded") {
      degraded += 1;
    }
  }

  return {
    total: sessions.length,
    active,
    degraded,
    dead,
  };
}
