/**
 * Team Configuration — Zod schemas and loader for team-related YAML config.
 *
 * Extends the base agent-orchestrator.yaml with:
 *   - teams: team presets (solo, pair, quad, custom)
 *   - learnings: .ao/learnings/ configuration
 *   - test_tasks: test task definitions
 *   - skills: global skill files
 *   - per-project defaultTeam
 */

import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  TEAM_PRESETS,
  type TeamDefinition,
  type TeamAgentConfig,
  type LearningsConfig,
  type TestTaskConfig,
} from "./team-types.js";

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

const PhaseSchema = z.enum([
  "plan",
  "validate",
  "implement",
  "integrate",
  "review",
  "revise",
  "test",
  "finalize",
  "refine",
]);

const AgentRoleSchema = z.enum(["planner", "driver", "reviewer", "tester"]);

const TeamAgentConfigSchema = z.object({
  role: AgentRoleSchema,
  model: z.string().optional(),
  agent: z.string().optional(),
  max_turns: z.number().optional(),
  prompt_file: z.string().optional(),
  skills: z.array(z.string()).optional(),
  on_demand: z.boolean().optional(),
});

const TeamDefinitionSchema = z.object({
  description: z.string(),
  phases: z.array(PhaseSchema),
  max_review_cycles: z.number().optional(),
  agents: z.record(TeamAgentConfigSchema),
});

const LearningsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  max_entries_per_file: z.number().default(50),
  stale_after_tasks: z.number().default(10),
  auto_prune_after_tasks: z.number().default(20),
  auto_commit: z.boolean().default(true),
});

const TestFailActionSchema = z.enum(["agent", "notify", "ignore"]);

const TestTaskConfigSchema = z.object({
  command: z.string(),
  timeout: z.number().default(300),
  required: z.boolean().default(true),
  on_fail: TestFailActionSchema.default("notify"),
  max_retries: z.number().optional(),
});

/** Full ao-teams extension schema */
const TeamsExtensionSchema = z.object({
  teams: z.record(TeamDefinitionSchema).optional(),
  skills: z.array(z.string()).optional(),
  learnings: LearningsConfigSchema.optional(),
  test_tasks: z.record(TestTaskConfigSchema).optional(),
});

// =============================================================================
// TYPES
// =============================================================================

/** Parsed team configuration (YAML snake_case normalized to camelCase) */
export interface TeamsConfig {
  teams: Record<string, TeamDefinition>;
  skills: string[];
  learnings: LearningsConfig;
  testTasks: Record<string, TestTaskConfig>;
}

// =============================================================================
// PARSING
// =============================================================================

/** Parse team configuration from raw YAML data */
export function parseTeamsConfig(raw: unknown): TeamsConfig {
  const parsed = TeamsExtensionSchema.parse(raw);

  // Normalize snake_case YAML keys to camelCase TypeScript types
  const teams: Record<string, TeamDefinition> = {};
  if (parsed.teams) {
    for (const [name, def] of Object.entries(parsed.teams)) {
      const agents: Record<string, TeamAgentConfig> = {};
      for (const [agentName, agentDef] of Object.entries(def.agents)) {
        agents[agentName] = {
          role: agentDef.role,
          model: agentDef.model,
          agent: agentDef.agent,
          maxTurns: agentDef.max_turns,
          promptFile: agentDef.prompt_file,
          skills: agentDef.skills,
          onDemand: agentDef.on_demand,
        };
      }

      teams[name] = {
        description: def.description,
        phases: def.phases,
        maxReviewCycles: def.max_review_cycles,
        agents,
      };
    }
  }

  const learnings: LearningsConfig = parsed.learnings
    ? {
        enabled: parsed.learnings.enabled,
        maxEntriesPerFile: parsed.learnings.max_entries_per_file,
        staleAfterTasks: parsed.learnings.stale_after_tasks,
        autoPruneAfterTasks: parsed.learnings.auto_prune_after_tasks,
        autoCommit: parsed.learnings.auto_commit,
      }
    : {
        enabled: true,
        maxEntriesPerFile: 50,
        staleAfterTasks: 10,
        autoPruneAfterTasks: 20,
        autoCommit: true,
      };

  const testTasks: Record<string, TestTaskConfig> = {};
  if (parsed.test_tasks) {
    for (const [name, task] of Object.entries(parsed.test_tasks)) {
      testTasks[name] = {
        command: task.command,
        timeout: task.timeout,
        required: task.required,
        onFail: task.on_fail,
        maxRetries: task.max_retries,
      };
    }
  }

  return {
    teams,
    skills: parsed.skills ?? [],
    learnings,
    testTasks,
  };
}

/** Load teams config from a YAML file */
export function loadTeamsConfig(configPath: string): TeamsConfig {
  if (!existsSync(configPath)) {
    return {
      teams: {},
      skills: [],
      learnings: {
        enabled: true,
        maxEntriesPerFile: 50,
        staleAfterTasks: 10,
        autoPruneAfterTasks: 20,
        autoCommit: true,
      },
      testTasks: {},
    };
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  return parseTeamsConfig(parsed);
}

/** Resolve a team definition by name (check custom teams, then presets) */
export function resolveTeam(
  teamName: string,
  customTeams: Record<string, TeamDefinition>,
): TeamDefinition | null {
  // Check custom teams first
  if (customTeams[teamName]) {
    return customTeams[teamName];
  }

  // Check built-in presets (imported statically)
  if (TEAM_PRESETS[teamName]) {
    return TEAM_PRESETS[teamName];
  }

  return null;
}
