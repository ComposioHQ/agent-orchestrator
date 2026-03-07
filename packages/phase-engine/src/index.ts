/**
 * @composio/ao-phase-engine
 *
 * Phase state machine and team orchestration engine for ao-teams.
 * Drives team execution through sequential phases (plan, validate,
 * implement, integrate, review, revise, test, finalize, refine).
 */

export { PhaseEngine } from "./phase-engine.js";
export type { PhaseEngineConfig, AgentSpawnContext } from "./phase-engine.js";

export { validatePlan } from "./plan-validator.js";

export { auditFileScope, revertOutOfScopeFiles } from "./file-scope-audit.js";
export type { FileScopeAuditOptions } from "./file-scope-audit.js";

export {
  initLearnings,
  readLearnings,
  readAllLearningsForInjection,
  applyRefineCommands,
  hasLearnings,
} from "./learnings.js";

export {
  generateBootstrapScript,
  writeBootstrapScript,
  generateToolkitClaudeMd,
  injectToolkitConfig,
} from "./bootstrap.js";
export type { BootstrapOptions } from "./bootstrap.js";

export { spawnTeam } from "./team-spawner.js";
export type { TeamSpawnOptions, TeamSpawnResult } from "./team-spawner.js";

export { buildTeamPrompt } from "./team-prompt-builder.js";
export type { TeamPromptConfig } from "./team-prompt-builder.js";
