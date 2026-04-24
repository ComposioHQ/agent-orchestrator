/**
 * Shared types and pure helpers used by session-manager.ts and its extracted
 * sibling modules (pr-claim, session-restore, etc.).
 *
 * These are internal to the session manager composition — they are not part of
 * the core package's public API. Anything exposed externally lives in
 * `types.ts` and `index.ts`.
 */

import type {
  Agent,
  OrchestratorConfig,
  PluginRegistry,
  ProjectConfig,
  Runtime,
  SCM,
  Session,
  SessionId,
  Tracker,
  Workspace,
} from "./types.js";
import type { ResolvedAgentSelection } from "./agent-selection.js";
import {
  buildLifecycleMetadataPatch,
  cloneLifecycle,
  parseCanonicalLifecycle,
} from "./lifecycle-state.js";
import { validateStatus } from "./utils/validation.js";

/** Session metadata + locator info returned from findSessionRecord. */
export interface LocatedSession {
  raw: Record<string, string>;
  sessionsDir: string;
  project: ProjectConfig;
  projectId: string;
}

/** A single active session metadata record with its filesystem mtime. */
export interface ActiveSessionRecord {
  sessionName: string;
  raw: Record<string, string>;
  modifiedAt?: Date;
}

/** Plugins resolved for a particular project/agent combination. */
export interface ResolvedPlugins {
  runtime: Runtime | null;
  agent: Agent | null;
  workspace: Workspace | null;
  tracker: Tracker | null;
  scm: SCM | null;
}

/** Outcome of resolveAgentSelection — re-exported as a type alias. */
export type AgentSelection = ResolvedAgentSelection;

/**
 * Dependency bundle shared between session-manager and the extracted modules.
 * session-manager constructs this and passes it into each module's entry
 * function.  This keeps extracted modules testable with mocks and keeps the
 * factory in session-manager.ts short.
 */
export interface SessionManagerContext {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  getProjectSessionsDir: (project: ProjectConfig) => string;
  findSessionRecord: (sessionId: SessionId) => LocatedSession | null;
  requireSessionRecord: (sessionId: SessionId) => LocatedSession;
  resolvePlugins: (project: ProjectConfig, agentName?: string) => ResolvedPlugins;
  resolveSelectionForSession: (
    project: ProjectConfig,
    sessionId: string,
    metadata: Record<string, string>,
  ) => AgentSelection;
  isOrchestratorSessionRecord: (
    sessionId: string,
    raw: Record<string, string> | null | undefined,
    sessionPrefix?: string,
  ) => boolean;
  loadActiveSessionRecords: (project: ProjectConfig) => ActiveSessionRecord[];
  metadataToSession: (
    sessionId: SessionId,
    meta: Record<string, string>,
    projectId: string,
    sessionPrefix?: string,
    createdAt?: Date,
    modifiedAt?: Date,
  ) => Session;
  enrichSessionWithRuntimeState: (
    session: Session,
    plugins: ResolvedPlugins,
    handleFromMetadata: boolean,
  ) => Promise<void>;
  invalidateCache: () => void;
}

/**
 * Build a cloned, updated canonical lifecycle for the given session/raw pair.
 * Pure helper — shared across session-manager.ts and extracted modules.
 */
export function buildUpdatedLifecycle(
  sessionId: string,
  raw: Record<string, string>,
  updater: (lifecycle: ReturnType<typeof parseCanonicalLifecycle>) => void,
) {
  const lifecycle = cloneLifecycle(
    parseCanonicalLifecycle(raw, {
      sessionId,
      status: validateStatus(raw["status"]),
    }),
  );
  updater(lifecycle);
  return lifecycle;
}

/**
 * Translate a canonical lifecycle back into the flat metadata key/value patch
 * that gets persisted to disk.
 */
export function lifecycleMetadataUpdates(
  raw: Record<string, string>,
  lifecycle: ReturnType<typeof parseCanonicalLifecycle>,
): Partial<Record<string, string>> {
  return buildLifecycleMetadataPatch(lifecycle, validateStatus(raw["status"]));
}

export const PR_TRACKING_STATUSES: ReadonlySet<string> = new Set([
  "pr_open",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
]);

export const STALE_PR_OWNERSHIP_STATUSES: ReadonlySet<string> = new Set([
  ...PR_TRACKING_STATUSES,
  "merged",
]);
