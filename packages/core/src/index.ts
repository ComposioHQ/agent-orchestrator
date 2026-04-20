/**
 * @aoagents/ao-core
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
export {
  createPluginRegistry,
  isPluginModule,
  normalizeImportedPluginModule,
  resolveLocalPluginEntrypoint,
  resolvePackageExportsEntry,
} from "./plugin-registry.js";

// Metadata — flat-file session metadata read/write
export {
  readMetadata,
  readMetadataRaw,
  writeMetadata,
  updateMetadata,
  readCanonicalLifecycle,
  writeCanonicalLifecycle,
  updateCanonicalLifecycle,
  deleteMetadata,
  listMetadata,
} from "./metadata.js";
export { createInitialCanonicalLifecycle, deriveLegacyStatus } from "./lifecycle-state.js";
export { sessionFromMetadata } from "./utils/session-from-metadata.js";

// Lifecycle transitions — centralized transition boundary (#137)
export {
  applyLifecycleDecision,
  applyDecisionToLifecycle,
  buildTransitionMetadataPatch,
  createStateTransitionDecision,
} from "./lifecycle-transition.js";
export type {
  TransitionSource,
  TransitionResult,
  ApplyDecisionInput,
} from "./lifecycle-transition.js";

// Lifecycle status decisions — pure decision helpers (#136)
export {
  DETECTING_MAX_ATTEMPTS,
  DETECTING_MAX_DURATION_MS,
  hashEvidence,
  isDetectingTimedOut,
} from "./lifecycle-status-decisions.js";

// Report watcher — background trigger system for agent reports (#140)
export {
  auditAgentReports,
  checkAcknowledgeTimeout,
  checkStaleReport,
  checkBlockedAgent,
  shouldAuditSession,
  getReactionKeyForTrigger,
  DEFAULT_REPORT_WATCHER_CONFIG,
  REPORT_WATCHER_METADATA_KEYS,
} from "./report-watcher.js";
export type {
  ReportWatcherTrigger,
  ReportAuditResult,
  ReportWatcherConfig,
} from "./report-watcher.js";

// Agent reports — explicit workflow transitions declared by worker agents (Stage 3)
export {
  AGENT_REPORTED_STATES,
  AGENT_REPORT_METADATA_KEYS,
  AGENT_REPORT_FRESHNESS_MS,
  applyAgentReport,
  readAgentReport,
  readAgentReportAuditTrail,
  readAgentReportAuditTrailAsync,
  isAgentReportFresh,
  mapAgentReportToLifecycle,
  normalizeAgentReportedState,
  validateAgentReportTransition,
} from "./agent-report.js";
export type {
  AgentReport,
  AgentReportAuditEntry,
  AgentReportAuditSnapshot,
  AgentReportedState,
  ApplyAgentReportInput,
  ApplyAgentReportResult,
  AgentReportTransitionResult,
} from "./agent-report.js";

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
export { buildPrompt, BASE_AGENT_PROMPT, BASE_AGENT_PROMPT_NO_REPO } from "./prompt-builder.js";
export type { PromptBuildConfig } from "./prompt-builder.js";

// Orchestrator prompt — generates orchestrator context for `ao start`
export { generateOrchestratorPrompt } from "./orchestrator-prompt.js";
export type { OrchestratorPromptConfig } from "./orchestrator-prompt.js";

// Shared utilities
export {
  shellEscape,
  escapeAppleScript,
  validateUrl,
  isGitBranchNameSafe,
  isRetryableHttpStatus,
  normalizeRetryConfig,
  readLastJsonlEntry,
  resolveProjectIdForSessionId,
} from "./utils.js";
export {
  getWebhookHeader,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
  parseWebhookBranchRef,
} from "./scm-webhook-utils.js";
export { asValidOpenCodeSessionId } from "./opencode-session-id.js";
export {
  getWorkspaceAgentsMdPath,
  writeWorkspaceOpenCodeAgentsMd,
} from "./opencode-agents-md.js";
export { normalizeOrchestratorSessionStrategy } from "./orchestrator-session-strategy.js";

// Activity log — JSONL activity tracking for agents without native JSONL
export {
  appendActivityEntry,
  readLastActivityEntry,
  checkActivityLogState,
  getActivityFallbackState,
  classifyTerminalActivity,
  recordTerminalActivity,
} from "./activity-log.js";
export {
  ACTIVITY_STRONG_WINDOW_MS,
  ACTIVITY_WEAK_WINDOW_MS,
  classifyActivitySignal,
  createActivitySignal,
  formatActivitySignalEvidence,
  hasPositiveIdleEvidence,
  isWeakActivityEvidence,
  summarizeActivityFreshness,
  supportsRecentLiveness,
} from "./activity-signal.js";

// Agent workspace hooks — shared PATH-wrapper setup for non-Claude agents
export {
  setupPathWrapperWorkspace,
  buildAgentPath,
  PREFERRED_GH_PATH,
} from "./agent-workspace-hooks.js";
export type { NormalizedOrchestratorSessionStrategy } from "./orchestrator-session-strategy.js";

export {
  createCorrelationId,
  createProjectObserver,
  readObservabilitySummary,
} from "./observability.js";
export { resolveNotifierTarget } from "./notifier-resolution.js";
export type {
  ObservabilityMetricName,
  ObservabilityHealthStatus,
  ObservabilityLevel,
  ObservabilitySummary,
  ProjectObserver,
} from "./observability.js";

// Feedback tools — contracts, validation, and report storage
export {
  FEEDBACK_TOOL_NAMES,
  FEEDBACK_TOOL_CONTRACTS,
  BugReportSchema,
  ImprovementSuggestionSchema,
  validateFeedbackToolInput,
  generateFeedbackDedupeKey,
  FeedbackReportStore,
} from "./feedback-tools.js";
export type {
  FeedbackToolName,
  FeedbackToolContract,
  BugReportInput,
  ImprovementSuggestionInput,
  FeedbackToolInput,
  PersistedFeedbackReport,
} from "./feedback-tools.js";

// Path utilities — hash-based directory structure
export {
  generateConfigHash,
  generateProjectId,
  generateInstanceId,
  generateSessionPrefix,
  getProjectBaseDir,
  getSessionsDir,
  getWorktreesDir,
  getFeedbackReportsDir,
  getObservabilityBaseDir,
  getArchiveDir,
  getOriginFilePath,
  generateSessionName,
  generateTmuxName,
  parseTmuxName,
  expandHome,
  validateAndStoreOrigin,
} from "./paths.js";

// Config generator — auto-generate config from repo URL
export {
  isRepoUrl,
  parseRepoUrl,
  detectScmPlatform,
  detectDefaultBranchFromDir,
  detectProjectInfo,
  generateConfigFromUrl,
  configToYaml,
  isRepoAlreadyCloned,
  resolveCloneTarget,
  sanitizeProjectId,
} from "./config-generator.js";
export type {
  ParsedRepoUrl,
  ScmPlatform,
  DetectedProjectInfo,
  GenerateConfigOptions,
} from "./config-generator.js";
