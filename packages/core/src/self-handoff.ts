/**
 * Self-Handoff Service
 *
 * Detects when an agent hits context limits and creates handoff documents
 * so a fresh session can pick up where the previous one left off.
 *
 * This is a core lifecycle enhancement, not a plugin.
 */

import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

// =============================================================================
// Types
// =============================================================================

/** A handoff document capturing context for session continuation */
export interface HandoffDocument {
  /** ID of the session being handed off from */
  fromSessionId: string;
  /** Project ID */
  projectId: string;
  /** Branch the session was working on */
  branch: string;
  /** Issue being worked on (if any) */
  issueId: string | null;
  /** Summary of work done so far */
  workSummary: string;
  /** What remains to be done */
  remainingWork: string;
  /** Current state/context */
  currentState: string;
  /** When the handoff was created */
  createdAt: Date;
  /** Path to the handoff document on disk */
  filePath: string;
}

/** Result of attempting to detect a context limit in agent output */
export interface HandoffDetection {
  /** Whether context limit was detected */
  detected: boolean;
  /** The pattern that matched */
  pattern?: string;
  /** Extracted context from the output */
  extractedContext?: string;
}

/** Configuration for the self-handoff service */
export interface SelfHandoffConfig {
  /** Directory to write handoff documents (default: workspace/.ao/handoffs/) */
  handoffDir?: string;
}

/** Parameters for creating a handoff document */
export interface CreateHandoffParams {
  sessionId: string;
  projectId: string;
  branch: string;
  issueId: string | null;
  workspacePath: string;
  workSummary: string;
  remainingWork: string;
  currentState: string;
}

/** The self-handoff service interface */
export interface SelfHandoff {
  /** Detect context limit from agent output */
  detectContextLimit(output: string): HandoffDetection;
  /** Create a handoff document for a session */
  createHandoffDocument(params: CreateHandoffParams): HandoffDocument;
  /** Read an existing handoff document */
  readHandoffDocument(filePath: string): HandoffDocument | null;
  /** Find handoff documents for a branch/issue */
  findHandoffs(workspacePath: string, branch?: string): HandoffDocument[];
  /** Generate a prompt for the new session based on handoff doc */
  generateHandoffPrompt(handoff: HandoffDocument): string;
  /** Clean up old handoff documents */
  cleanupHandoffs(workspacePath: string, maxAge?: number): number;
}

// =============================================================================
// Context limit detection patterns
// =============================================================================

/**
 * Patterns that indicate an agent has hit its context limit.
 * Each pattern is a case-insensitive regex.
 */
const CONTEXT_LIMIT_PATTERNS: ReadonlyArray<{ regex: RegExp; label: string }> = [
  // More specific patterns first to avoid partial matches
  { regex: /context\s+window\s+is\s+full/i, label: "context window is full" },
  { regex: /maximum\s+context\s+length/i, label: "maximum context length" },
  { regex: /running\s+out\s+of\s+context/i, label: "running out of context" },
  { regex: /conversation\s+is\s+too\s+long/i, label: "Conversation is too long" },
  { regex: /conversation\s+too\s+long/i, label: "conversation too long" },
  { regex: /context\s+window/i, label: "context window" },
  { regex: /context\s+exceeded/i, label: "context exceeded" },
  { regex: /context\s+limit/i, label: "context limit" },
  { regex: /token\s+limit/i, label: "token limit" },
  { regex: /token\s+budget/i, label: "token budget" },
];

// =============================================================================
// Constants
// =============================================================================

/** Default subdirectory within workspace for handoff documents */
const DEFAULT_HANDOFF_SUBDIR = ".ao/handoffs";

/** Default max age for handoff documents: 7 days in milliseconds */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Resolve the handoff directory for a given workspace path and optional config override.
 */
function resolveHandoffDir(workspacePath: string, configDir?: string): string {
  return configDir ?? join(workspacePath, DEFAULT_HANDOFF_SUBDIR);
}

/**
 * Extract surrounding context from agent output around the matched pattern.
 * Returns up to ~200 characters around the match for diagnostic purposes.
 */
function extractContext(output: string, regex: RegExp): string {
  const match = regex.exec(output);
  if (!match || match.index === undefined) return "";

  const start = Math.max(0, match.index - 100);
  const end = Math.min(output.length, match.index + match[0].length + 100);
  const snippet = output.slice(start, end).trim();
  return snippet;
}

/**
 * Parse a handoff JSON file safely.
 * Returns null if the file is missing, corrupt, or not valid JSON.
 */
function parseHandoffFile(filePath: string): HandoffDocument | null {
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required fields
  if (
    typeof obj["fromSessionId"] !== "string" ||
    typeof obj["projectId"] !== "string" ||
    typeof obj["branch"] !== "string" ||
    typeof obj["workSummary"] !== "string" ||
    typeof obj["remainingWork"] !== "string" ||
    typeof obj["currentState"] !== "string" ||
    typeof obj["createdAt"] !== "string" ||
    typeof obj["filePath"] !== "string"
  ) {
    return null;
  }

  const createdAt = new Date(obj["createdAt"] as string);
  if (isNaN(createdAt.getTime())) return null;

  return {
    fromSessionId: obj["fromSessionId"] as string,
    projectId: obj["projectId"] as string,
    branch: obj["branch"] as string,
    issueId: obj["issueId"] === null || obj["issueId"] === undefined ? null : String(obj["issueId"]),
    workSummary: obj["workSummary"] as string,
    remainingWork: obj["remainingWork"] as string,
    currentState: obj["currentState"] as string,
    createdAt,
    filePath: obj["filePath"] as string,
  };
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a SelfHandoff service instance.
 *
 * @param config - Optional configuration overrides
 * @returns A SelfHandoff service object
 */
export function createSelfHandoff(config?: SelfHandoffConfig): SelfHandoff {
  const configHandoffDir = config?.handoffDir;

  function detectContextLimit(output: string): HandoffDetection {
    for (const { regex, label } of CONTEXT_LIMIT_PATTERNS) {
      if (regex.test(output)) {
        // Reset lastIndex for stateless regex (no /g flag, but be safe)
        regex.lastIndex = 0;
        const extractedContext = extractContext(output, regex);
        return {
          detected: true,
          pattern: label,
          extractedContext: extractedContext || undefined,
        };
      }
    }
    return { detected: false };
  }

  function createHandoffDocument(params: CreateHandoffParams): HandoffDocument {
    const {
      sessionId,
      projectId,
      branch,
      issueId,
      workspacePath,
      workSummary,
      remainingWork,
      currentState,
    } = params;

    const handoffDir = resolveHandoffDir(workspacePath, configHandoffDir);
    mkdirSync(handoffDir, { recursive: true });

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    const fileName = `${sessionId}-${timestamp}.json`;
    const filePath = join(handoffDir, fileName);

    const doc: HandoffDocument = {
      fromSessionId: sessionId,
      projectId,
      branch,
      issueId,
      workSummary,
      remainingWork,
      currentState,
      createdAt: now,
      filePath,
    };

    // Serialize with createdAt as ISO string for JSON compatibility
    const serializable = {
      ...doc,
      createdAt: now.toISOString(),
    };

    writeFileSync(filePath, JSON.stringify(serializable, null, 2), "utf-8");

    return doc;
  }

  function readHandoffDocument(filePath: string): HandoffDocument | null {
    return parseHandoffFile(filePath);
  }

  function findHandoffs(workspacePath: string, branch?: string): HandoffDocument[] {
    const handoffDir = resolveHandoffDir(workspacePath, configHandoffDir);

    if (!existsSync(handoffDir)) return [];

    let entries: string[];
    try {
      entries = readdirSync(handoffDir);
    } catch {
      return [];
    }

    const documents: HandoffDocument[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;

      const filePath = join(handoffDir, entry);
      const doc = parseHandoffFile(filePath);
      if (!doc) continue;

      if (branch !== undefined && doc.branch !== branch) continue;

      documents.push(doc);
    }

    // Sort by createdAt descending (most recent first)
    documents.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return documents;
  }

  function generateHandoffPrompt(handoff: HandoffDocument): string {
    const lines: string[] = [
      "## Session Handoff",
      "",
      `This session is a continuation of session \`${handoff.fromSessionId}\` which hit its context limit.`,
      "",
      `**Project:** ${handoff.projectId}`,
      `**Branch:** ${handoff.branch}`,
    ];

    if (handoff.issueId) {
      lines.push(`**Issue:** ${handoff.issueId}`);
    }

    lines.push(
      "",
      "### Work Completed So Far",
      handoff.workSummary,
      "",
      "### Remaining Work",
      handoff.remainingWork,
      "",
      "### Current State",
      handoff.currentState,
      "",
      "---",
      "",
      "Please continue the work described above. The branch already has the previous changes committed.",
    );

    return lines.join("\n");
  }

  function cleanupHandoffs(workspacePath: string, maxAge?: number): number {
    const handoffDir = resolveHandoffDir(workspacePath, configHandoffDir);

    if (!existsSync(handoffDir)) return 0;

    const maxAgeMs = maxAge ?? DEFAULT_MAX_AGE_MS;
    const cutoff = Date.now() - maxAgeMs;
    let removedCount = 0;

    let entries: string[];
    try {
      entries = readdirSync(handoffDir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;

      const filePath = join(handoffDir, entry);

      try {
        const info = statSync(filePath);
        if (info.mtimeMs < cutoff) {
          unlinkSync(filePath);
          removedCount++;
        }
      } catch {
        // File may have been removed concurrently; skip
      }
    }

    return removedCount;
  }

  return {
    detectContextLimit,
    createHandoffDocument,
    readHandoffDocument,
    findHandoffs,
    generateHandoffPrompt,
    cleanupHandoffs,
  };
}
