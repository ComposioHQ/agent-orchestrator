/**
 * @composio/ao-core
 *
 * Core library for the Agent Orchestrator.
 * Exports all types, config loader, and service implementations.
 */

// Types — everything plugins and consumers need
export * from "./types.js";

// Config — YAML loader + validation
export {
  loadConfig,
  loadConfigWithPath,
  validateConfig,
  getDefaultConfig,
  findConfig,
  findConfigFile,
} from "./config.js";

// Plugin registry
export { createPluginRegistry } from "./plugin-registry.js";

// Metadata — flat-file session metadata read/write
export {
  readMetadata,
  readMetadataRaw,
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
} from "./metadata.js";

// tmux — command wrappers
export {
  isTmuxAvailable,
  listSessions as listTmuxSessions,
  hasSession as hasTmuxSession,
  newSession as newTmuxSession,
  sendKeys as tmuxSendKeys,
  capturePane as tmuxCapturePane,
  killSession as killTmuxSession,
  getPaneTTY as getTmuxPaneTTY,
} from "./tmux.js";

// Session manager — session CRUD
export { createSessionManager } from "./session-manager.js";
export type { SessionManagerDeps } from "./session-manager.js";

// Lifecycle manager — state machine + reaction engine
export { createLifecycleManager } from "./lifecycle-manager.js";
export type { LifecycleManagerDeps } from "./lifecycle-manager.js";

// Prompt builder — layered prompt composition
export { buildPrompt, BASE_AGENT_PROMPT } from "./prompt-builder.js";
export type { PromptBuildConfig } from "./prompt-builder.js";

// Orchestrator prompt — generates orchestrator context for `ao start`
export { generateOrchestratorPrompt } from "./orchestrator-prompt.js";
export type { OrchestratorPromptConfig } from "./orchestrator-prompt.js";

// Cycle detector — loop/cycle detection for session lifecycle
export { createCycleDetector } from "./cycle-detector.js";
export type {
  CycleDetectorConfig,
  CycleInfo,
  LoopInfo,
  CycleVerdict,
  CycleJudgment,
  CycleDetector,
} from "./cycle-detector.js";

// Self-handoff — context limit detection + session continuation
export { createSelfHandoff } from "./self-handoff.js";
export type {
  HandoffDocument,
  HandoffDetection,
  SelfHandoffConfig,
  CreateHandoffParams,
  SelfHandoff,
} from "./self-handoff.js";

// Shared utilities
export { shellEscape, escapeAppleScript, validateUrl, readLastJsonlEntry } from "./utils.js";

// Rate limit tracker — tracks rate-limited executables with fallback chains
export { createRateLimitTracker } from "./rate-limit-tracker.js";
export type {
  RateLimitEntry,
  RateLimitTrackerConfig,
  RateLimitDetection,
  RateLimitTracker,
} from "./rate-limit-tracker.js";

// Worker pool — enforces concurrency limits for session spawning
export { createWorkerPool } from "./worker-pool.js";
export type {
  WorkerPoolConfig,
  PoolStatus,
  SpawnCheck,
  WorkerPool,
} from "./worker-pool.js";

// Movement permissions — per-phase permission service
export { createMovementPermissions } from "./movement-permissions.js";
export type {
  PermissionMode,
  MovementPhase,
  MovementPermission,
  PermissionsConfig,
  PermissionCheck,
  MovementPermissions,
} from "./movement-permissions.js";

// Path utilities — hash-based directory structure
export {
  generateConfigHash,
  generateProjectId,
  generateInstanceId,
  generateSessionPrefix,
  getProjectBaseDir,
  getSessionsDir,
  getWorktreesDir,
  getArchiveDir,
  getOriginFilePath,
  generateSessionName,
  generateTmuxName,
  parseTmuxName,
  expandHome,
  validateAndStoreOrigin,
} from "./paths.js";
