/**
 * Memory System Types — Zod schemas for session and project memory.
 *
 * Three-layer memory architecture:
 * 1. Raw Session History — transcripts from agents (already exists in agent JSONL)
 * 2. Session Memory — per-session structured JSON extracted by AO at session end
 * 3. Project Memory — aggregated knowledge injected into new sessions
 *
 * IMPORTANT: When modifying any schema in this file (SessionMemorySchema,
 * ProjectMemorySchema, etc.), increment MEMORY_VERSION and update the
 * `version: z.literal(N)` fields to match. This ensures old persisted
 * data can be detected and migrated.
 */

import { z } from "zod";

// =============================================================================
// SESSION MEMORY
// =============================================================================

/**
 * An observation is a timestamped piece of knowledge.
 */
export const ObservationSchema = z.object({
  content: z.string(),
  ts: z.string(), // ISO 8601 timestamp
});

export type Observation = z.infer<typeof ObservationSchema>;

/**
 * Session Memory schema — extracted from a completed session.
 * Stored as {sessionId}.memory.json alongside session metadata.
 */
export const SessionMemorySchema = z.object({
  /** Session ID this memory belongs to */
  sessionId: z.string(),

  /** Brief description of the task that was worked on */
  task: z.string(),

  /** Final session status (merged, done, cleanup, errored) */
  status: z.string(),

  /** Project-specific learnings and discoveries */
  facts: z.array(z.string()),

  /** Key-value pairs of discovered entities (file paths, config keys, API endpoints, etc.) */
  entities: z.record(z.string(), z.string()),

  /** Timestamped observations made during the session */
  observations: z.array(ObservationSchema),

  /** When this memory was last updated (ISO 8601) */
  updatedAt: z.string(),

  /** When the session completed (ISO 8601) */
  completedAt: z.string(),

  /** Schema version for future migrations */
  version: z.literal(1),
});

export type SessionMemory = z.infer<typeof SessionMemorySchema>;

// =============================================================================
// PROJECT MEMORY
// =============================================================================

/**
 * Project Memory schema — aggregated knowledge from all sessions.
 * Stored as project-memory.json at the project base directory.
 */
export const ProjectMemorySchema = z.object({
  /** Aggregated facts from all sessions (deduplicated) */
  facts: z.array(z.string()),

  /** Merged entities from all sessions (newer values win) */
  entities: z.record(z.string(), z.string()),

  /** Recent observations (capped at 20, most recent first) */
  observations: z.array(ObservationSchema),

  /** When this memory was last updated (ISO 8601) */
  updatedAt: z.string(),

  /** Number of sessions that contributed to this memory */
  sessionCount: z.number().int().nonnegative(),

  /** Schema version for future migrations */
  version: z.literal(1),
});

export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;

// =============================================================================
// EXTRACTION OUTPUT
// =============================================================================

/**
 * Raw extraction output from the agent before validation.
 * More lenient than SessionMemory to handle partial extractions.
 */
export const ExtractionOutputSchema = z.object({
  task: z.string().optional(),
  facts: z.array(z.string()).optional(),
  entities: z.record(z.string(), z.string()).optional(),
  observations: z
    .array(
      z.object({
        content: z.string(),
        ts: z.string().optional(),
      }),
    )
    .optional(),
});

export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

// =============================================================================
// CONSTANTS
// =============================================================================

/** Current schema version */
export const MEMORY_VERSION = 1 as const;

/** Maximum number of observations to keep in project memory */
export const MAX_PROJECT_OBSERVATIONS = 20;

/** Maximum transcript size in bytes before truncation */
export const MAX_TRANSCRIPT_BYTES = 512 * 1024; // 512KB

/** Extraction session timeout in milliseconds */
export const EXTRACTION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Terminal statuses that trigger memory extraction */
export const MEMORY_TRIGGER_STATUSES = new Set([
  "merged",
  "done",
  "cleanup",
  "errored",
]);

/** Statuses that should NOT trigger memory extraction (incomplete work) */
export const MEMORY_SKIP_STATUSES = new Set(["killed", "terminated"]);
