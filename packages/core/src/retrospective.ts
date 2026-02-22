/**
 * Retrospective — structured analysis of completed sessions.
 *
 * Generates retrospectives from event logs and session metadata,
 * extracting timeline, metrics, and heuristic lessons learned.
 * Saves to JSON files for later querying by agents and CLI.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateReportCard } from "./session-report-card.js";
import { readLogs } from "./log-reader.js";
import { readMetadataRaw } from "./metadata.js";
import { getSessionsDir, getLogsDir } from "./paths.js";
import type { OrchestratorConfig, Retrospective, RetrospectiveStore, SessionReportCard } from "./types.js";

// Thresholds for heuristic lesson extraction
const CI_FAILURE_HIGH = 3;       // >3 CI failures = "high failure count" lesson
const CI_FAILURE_LOW = 1;        // >1 CI failures = "failed N times" lesson
const REVIEW_ROUNDS_HIGH = 2;    // >2 review rounds = "multiple rounds" lesson
const SESSION_LONG_HOURS = 24;   // >24h = "long-running" lesson
const SESSION_QUICK_HOURS = 2;   // <2h + no CI/review issues = "clean execution" lesson

/** Generate a retrospective for a completed session. */
export function generateRetrospective(
  sessionId: string,
  config: OrchestratorConfig,
  projectId: string,
): Retrospective | null {
  const project = config.projects[projectId];
  if (!project) return null;

  const sessionsDir = getSessionsDir(config.configPath, project.path);
  const logsDir = getLogsDir(config.configPath, project.path);
  const eventsLogPath = join(logsDir, "events.jsonl");

  // Read metadata (try live, then archived)
  let metadata = readMetadataRaw(sessionsDir, sessionId);
  if (!metadata) {
    metadata = readMetadataRaw(join(sessionsDir, "archive"), sessionId);
  }
  if (!metadata) {
    metadata = { project: projectId };
  }

  const reportCard = generateReportCard(sessionId, eventsLogPath, metadata);

  // Build timeline from events
  const entries = readLogs(eventsLogPath, { sessionId });
  const timeline: Retrospective["timeline"] = entries.map((e) => ({
    event: String(e.data?.["type"] ?? e.level),
    at: e.ts,
    detail: e.message,
  }));

  // Determine outcome
  let outcome: Retrospective["outcome"];
  if (reportCard.outcome === "merged") {
    outcome = "success";
  } else if (reportCard.outcome === "killed" || reportCard.outcome === "abandoned") {
    outcome = "failure";
  } else {
    outcome = "partial";
  }

  // Extract heuristic lessons
  const lessons = extractLessons(reportCard, timeline);

  return {
    sessionId,
    projectId,
    generatedAt: new Date().toISOString(),
    outcome,
    timeline,
    metrics: {
      totalDurationMs: reportCard.duration.totalMs,
      ciFailures: reportCard.ciAttempts,
      reviewRounds: reportCard.reviewRounds,
    },
    lessons,
    reportCard,
  };
}

/** Save a retrospective to disk. */
export function saveRetrospective(retro: Retrospective, retrospectivesDir: string): void {
  if (!existsSync(retrospectivesDir)) {
    mkdirSync(retrospectivesDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${retro.sessionId}-${timestamp}.json`;
  const filePath = join(retrospectivesDir, filename);

  writeFileSync(filePath, JSON.stringify(retro, null, 2), "utf-8");
}

/** Load retrospectives from disk, optionally filtered. */
export function loadRetrospectives(
  retrospectivesDir: string,
  opts?: { sessionId?: string; projectId?: string; limit?: number },
): Retrospective[] {
  if (!existsSync(retrospectivesDir)) return [];

  let files: string[];
  try {
    files = readdirSync(retrospectivesDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }

  // Filter by session ID — match exact session followed by timestamp delimiter
  if (opts?.sessionId) {
    files = files.filter((f) => f.startsWith(`${opts.sessionId!}-`));
  }

  const results: Retrospective[] = [];
  for (const file of files) {
    if (opts?.limit && results.length >= opts.limit) break;

    try {
      const content = readFileSync(join(retrospectivesDir, file), "utf-8");
      const retro = JSON.parse(content) as Retrospective;

      if (opts?.projectId && retro.projectId !== opts.projectId) continue;
      results.push(retro);
    } catch {
      // Corrupted file — skip
    }
  }

  return results;
}

/** Extract heuristic lessons from session metrics. */
function extractLessons(
  card: SessionReportCard,
  timeline: Retrospective["timeline"],
): string[] {
  const lessons: string[] = [];

  // CI failure patterns
  if (card.ciAttempts > CI_FAILURE_HIGH) {
    lessons.push(
      `High CI failure count (${card.ciAttempts} failures). Consider running tests locally before pushing.`,
    );
  } else if (card.ciAttempts > CI_FAILURE_LOW) {
    lessons.push(`CI failed ${card.ciAttempts} times before passing.`);
  }

  // Review round patterns
  if (card.reviewRounds > REVIEW_ROUNDS_HIGH) {
    lessons.push(
      `Multiple review rounds (${card.reviewRounds}). Breaking changes into smaller PRs may help.`,
    );
  }

  // Duration anomalies
  const hours = card.duration.totalMs / 3_600_000;
  if (hours > SESSION_LONG_HOURS) {
    lessons.push(
      `Session ran for ${Math.round(hours)} hours. Long-running sessions may indicate complexity or blocking.`,
    );
  }

  // Quick success
  if (card.outcome === "merged" && card.ciAttempts <= CI_FAILURE_LOW && card.reviewRounds <= 1 && hours < SESSION_QUICK_HOURS) {
    lessons.push("Clean execution: merged quickly with minimal CI/review iterations.");
  }

  // Killed without PR
  if (card.outcome === "killed" && !card.prUrl) {
    lessons.push("Session was killed without creating a PR. May indicate a stuck or misdirected session.");
  }

  // No events at all
  if (timeline.length === 0) {
    lessons.push("No lifecycle events recorded. Session may have been very short-lived or logging was not active.");
  }

  return lessons;
}

/**
 * Default RetrospectiveStore implementation backed by JSON files on disk.
 * Each retrospective is saved as `{sessionId}-{timestamp}.json`.
 */
export class JsonlRetrospectiveStore implements RetrospectiveStore {
  constructor(private readonly dir: string) {}

  save(retro: Retrospective): void {
    saveRetrospective(retro, this.dir);
  }

  load(opts?: { sessionId?: string; projectId?: string; limit?: number }): Retrospective[] {
    return loadRetrospectives(this.dir, opts);
  }
}
