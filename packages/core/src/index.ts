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

// Shared utilities
export { shellEscape, escapeAppleScript, validateUrl, readLastJsonlEntry, percentile, normalizeRoutePath } from "./utils.js";

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
  getLogsDir,
  getRetrospectivesDir,
  resolveProjectLogDir,
  resolveProjectRetroDir,
  getOriginFilePath,
  generateSessionName,
  generateTmuxName,
  parseTmuxName,
  expandHome,
  validateAndStoreOrigin,
} from "./paths.js";

// Log writer — JSONL structured logging with rotation (default EventLogger implementation)
export { LogWriter } from "./log-writer.js";
export type { LogWriterOptions } from "./log-writer.js";

// Log reader — query and filter JSONL logs
export { readLogs, readLogsFromDir, tailLogs, parseApiLogs, computeApiStats } from "./log-reader.js";
export type { ApiLogEntry, RouteStats, ApiPerfResult } from "./log-reader.js";

// Session report card — per-session metrics
export { generateReportCard } from "./session-report-card.js";

// Retrospective — session analysis (includes default RetrospectiveStore implementation)
export { generateRetrospective, saveRetrospective, loadRetrospectives, JsonlRetrospectiveStore } from "./retrospective.js";

// Dashboard manager — programmatic dashboard process control
export { restartDashboard, waitForHealthy, getDashboardStatus, stopDashboard, readPidFile, writePidFile, removePidFile } from "./dashboard-manager.js";
export type { DashboardRestartOpts, DashboardRestartResult } from "./dashboard-manager.js";
