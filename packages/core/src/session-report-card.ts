/**
 * Session Report Card — per-session metrics extracted from event logs.
 *
 * Generates a structured summary of a session's lifecycle: duration,
 * state transitions, CI attempts, review rounds, and outcome.
 */

import { readLogs } from "./log-reader.js";
import type { SessionReportCard } from "./types.js";

/** Generate a report card for a session from its event log entries. */
export function generateReportCard(
  sessionId: string,
  eventsLogPath: string,
  metadata: Record<string, string>,
): SessionReportCard {
  const entries = readLogs(eventsLogPath, { sessionId });

  const transitions: SessionReportCard["stateTransitions"] = [];
  let ciAttempts = 0;
  let reviewRounds = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  for (const entry of entries) {
    if (!startedAt) {
      startedAt = entry.ts;
    }
    endedAt = entry.ts;

    const data = entry.data ?? {};

    // Track state transitions
    if (data["oldStatus"] && data["newStatus"]) {
      transitions.push({
        from: String(data["oldStatus"]),
        to: String(data["newStatus"]),
        at: entry.ts,
      });
    }

    // Count CI attempts (transitions to ci_failed)
    if (data["type"] === "ci.failing" || data["newStatus"] === "ci_failed") {
      ciAttempts++;
    }

    // Count review rounds (transitions to changes_requested)
    if (data["type"] === "review.changes_requested" || data["newStatus"] === "changes_requested") {
      reviewRounds++;
    }
  }

  // Determine outcome from last known status
  const lastStatus = transitions.length > 0
    ? transitions[transitions.length - 1].to
    : metadata["status"] ?? "active";

  let outcome: SessionReportCard["outcome"];
  if (lastStatus === "merged") outcome = "merged";
  else if (lastStatus === "killed") outcome = "killed";
  else if (lastStatus === "abandoned") outcome = "abandoned";
  else outcome = "active";

  const now = new Date().toISOString();
  const start = startedAt ?? metadata["createdAt"] ?? now;
  const end = outcome !== "active" ? (endedAt ?? now) : null;

  return {
    sessionId,
    projectId: metadata["project"] ?? "",
    duration: {
      startedAt: start,
      endedAt: end,
      totalMs: end ? new Date(end).getTime() - new Date(start).getTime() : Date.now() - new Date(start).getTime(),
    },
    stateTransitions: transitions,
    ciAttempts,
    reviewRounds,
    outcome,
    prUrl: metadata["pr"] ?? null,
  };
}
