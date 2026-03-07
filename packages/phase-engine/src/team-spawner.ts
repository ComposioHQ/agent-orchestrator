/**
 * Team Spawner — connects PhaseEngine to AO's Runtime and Agent plugins.
 *
 * This is the integration layer that bridges ao-teams (PhaseEngine, AgentBus)
 * with Agent Orchestrator's plugin system (Runtime, Agent, Workspace).
 *
 * Flow:
 *   1. Create workspace (worktree) via Workspace plugin
 *   2. Initialize .agents/ directory
 *   3. Copy ao-bus-cli binary into .agents/bin/
 *   4. For each phase activation:
 *      a. Build 8-layer prompt via TeamPromptBuilder
 *      b. Get agent launch command via Agent plugin
 *      c. Create tmux pane via Runtime plugin
 *      d. Phase engine monitors status files
 *      e. On completion, runtime is destroyed
 */

import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Phase,
  TeamDefinition,
  Runtime,
  Agent,
  Workspace,
  RuntimeHandle,
  AgentLaunchConfig,
  ProjectConfig,
  TestTaskConfig,
  TeamSessionState,
} from "@composio/ao-core";
import { AgentBus } from "@composio/ao-agent-bus";
import { PhaseEngine, type PhaseEngineConfig, type AgentSpawnContext } from "./phase-engine.js";
import { buildTeamPrompt } from "./team-prompt-builder.js";
import { readAllLearningsForInjection } from "./learnings.js";
import { writeBootstrapScript, injectToolkitConfig } from "./bootstrap.js";

const execFileAsync = promisify(execFile);

/** Options for spawning a team */
export interface TeamSpawnOptions {
  /** Project configuration */
  project: ProjectConfig;
  /** Project ID */
  projectId: string;
  /** Team definition */
  team: TeamDefinition;
  /** Team preset name */
  teamName: string;
  /** Task description (issue body or user prompt) */
  taskDescription: string;
  /** Issue ID (if spawning for an issue) */
  issueId?: string;
  /** Branch name override */
  branch?: string;
  /** Global skill file paths (from YAML config) */
  globalSkills?: string[];
  /** Runtime plugin instance */
  runtime: Runtime;
  /** Agent plugin instance (default agent backend) */
  agent: Agent;
  /** Workspace plugin instance */
  workspace?: Workspace;
  /** Notifier callback for human notifications */
  notifyHuman?: (message: string, priority: "urgent" | "info") => Promise<void>;
  /** Test task configurations */
  testTasks?: Record<string, TestTaskConfig>;
}

/** Result of spawning a team */
export interface TeamSpawnResult {
  /** Path to the worktree */
  worktreePath: string;
  /** Branch name */
  branch: string;
  /** Team session state */
  state: TeamSessionState;
}

/**
 * Spawn a team and run it through the phase engine.
 * This is the main entry point for team execution.
 */
export async function spawnTeam(options: TeamSpawnOptions): Promise<TeamSpawnResult> {
  const {
    project,
    projectId,
    team,
    teamName,
    taskDescription,
    issueId,
    runtime,
    agent: defaultAgent,
    workspace,
    notifyHuman,
    testTasks,
    globalSkills,
  } = options;

  // Determine branch
  const branch = options.branch ?? (issueId ? `feat/${issueId}` : `team/${teamName}-${Date.now()}`);

  // Create workspace (worktree)
  let worktreePath = project.path;
  if (workspace) {
    const wsInfo = await workspace.create({
      projectId,
      project,
      sessionId: `team-${teamName}-${Date.now()}`,
      branch,
    });
    worktreePath = wsInfo.path;

    if (workspace.postCreate) {
      await workspace.postCreate(wsInfo, project);
    }
  }

  const agentsDir = join(worktreePath, ".agents");
  const activeHandles = new Map<string, RuntimeHandle>();

  // Copy ao-bus-cli binary into .agents/bin/
  await setupToolkit(agentsDir);

  // Read learnings once for all agents
  const learningsContent = readAllLearningsForInjection(worktreePath);

  // Read toolkit skill file once
  const toolkitSkillPath = resolveToolkitSkillPath();
  const toolkitSkill = toolkitSkillPath && existsSync(toolkitSkillPath)
    ? readFileSync(toolkitSkillPath, "utf-8")
    : undefined;

  // Build the spawnAgent callback for the phase engine
  const spawnAgent = async (
    agentName: string,
    role: string,
    phase: Phase,
    context: AgentSpawnContext,
  ): Promise<void> => {
    const agentConfig = team.agents[agentName];

    // Write bootstrap script
    writeBootstrapScript({
      agentName,
      phase,
      worktreePath,
      agentsDir,
      fileScope: context.fileScope,
      sharedFiles: context.sharedFiles,
    });

    // Inject toolkit config into worktree's .claude/CLAUDE.md
    injectToolkitConfig(worktreePath, {
      agentName,
      phase,
      worktreePath,
      agentsDir,
      fileScope: context.fileScope,
      sharedFiles: context.sharedFiles,
    });

    // Build the 8-layer prompt
    const messages = context.bus.readMessagesFor(agentName);
    const priorWork = await getPriorWork(worktreePath, phase);

    const prompt = buildTeamPrompt({
      agentName,
      role,
      phase,
      worktreePath,
      agentsDir,
      fileScope: context.fileScope,
      sharedFiles: context.sharedFiles,
      agentConfig,
      globalSkills,
      phaseInstructions: context.phaseInstructions,
      taskDescription: context.taskDescription,
      plan: context.plan ?? undefined,
      messages: messages.length > 0 ? messages : undefined,
      priorWork: priorWork ?? undefined,
      toolkitSkill,
      learningsContent: learningsContent || undefined,
    });

    // Get agent launch config
    const launchConfig: AgentLaunchConfig = {
      sessionId: `${teamName}-${agentName}-${phase}`,
      projectConfig: project,
      issueId,
      prompt,
      permissions: agentConfig?.agent ? undefined : project.agentConfig?.permissions,
      model: agentConfig?.model,
    };

    const launchCommand = defaultAgent.getLaunchCommand(launchConfig);
    const agentEnv = defaultAgent.getEnvironment(launchConfig);

    // Create runtime (tmux pane)
    const handle = await runtime.create({
      sessionId: `${teamName}-${agentName}-${phase}`,
      workspacePath: worktreePath,
      launchCommand,
      environment: {
        ...agentEnv,
        ...context.environment,
      },
    });

    activeHandles.set(agentName, handle);

    // Send prompt via post-launch if needed
    if (defaultAgent.promptDelivery === "post-launch") {
      await runtime.sendMessage(handle, prompt);
    }
  };

  // Build the killAgent callback
  const killAgent = async (agentName: string): Promise<void> => {
    const handle = activeHandles.get(agentName);
    if (handle) {
      try {
        await runtime.destroy(handle);
      } catch {
        // Best effort cleanup
      }
      activeHandles.delete(agentName);
    }
  };

  // Create and run the phase engine
  const engineConfig: PhaseEngineConfig = {
    worktreePath,
    team,
    teamName,
    taskDescription,
    testTasks,
    spawnAgent,
    killAgent,
    notifyHuman,
  };

  const engine = new PhaseEngine(engineConfig);
  const state = await engine.run();

  // Cleanup: destroy all remaining runtime handles
  for (const [, handle] of activeHandles) {
    try {
      await runtime.destroy(handle);
    } catch {
      // Best effort
    }
  }
  activeHandles.clear();

  return {
    worktreePath,
    branch,
    state,
  };
}

/** Set up the toolkit in .agents/bin/ */
async function setupToolkit(agentsDir: string): Promise<void> {
  const bus = new AgentBus({ agentsDir });
  bus.init();

  // Copy ao-bus.sh into .agents/bin/
  const aoBusShSrc = resolveAoBusSh();
  if (aoBusShSrc && existsSync(aoBusShSrc)) {
    copyFileSync(aoBusShSrc, join(agentsDir, "bin", "ao-bus.sh"));
  }
}

/** Resolve path to ao-bus.sh from the agent-bus package */
function resolveAoBusSh(): string | null {
  try {
    // Try relative to this file (phase-engine package)
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(thisDir, "..", "..", "..", "agent-bus", "ao-bus.sh");
    if (existsSync(candidate)) return candidate;

    // Try from node_modules
    const nmCandidate = resolve(thisDir, "..", "..", "node_modules", "@composio", "ao-agent-bus", "ao-bus.sh");
    if (existsSync(nmCandidate)) return nmCandidate;

    return null;
  } catch {
    return null;
  }
}

/** Resolve path to ao-bus.md skill file */
function resolveToolkitSkillPath(): string | null {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(thisDir, "..", "..", "..", "agent-bus", "ao-bus.md");
    if (existsSync(candidate)) return candidate;

    const nmCandidate = resolve(thisDir, "..", "..", "node_modules", "@composio", "ao-agent-bus", "ao-bus.md");
    if (existsSync(nmCandidate)) return nmCandidate;

    return null;
  } catch {
    return null;
  }
}

/** Get prior work context for a phase (git diff, review report, etc.) */
async function getPriorWork(worktreePath: string, phase: Phase): Promise<string | null> {
  const parts: string[] = [];

  // Git diff for review-dependent phases
  if (phase === "review" || phase === "revise" || phase === "test") {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "HEAD~1"],
        { cwd: worktreePath, timeout: 30_000 },
      );
      if (stdout.trim()) {
        parts.push(`### Git Diff\n\`\`\`diff\n${stdout.slice(0, 8000)}\n\`\`\``);
      }
    } catch {
      // No diff available
    }
  }

  // Review report for revise phase
  if (phase === "revise") {
    const bus = new AgentBus({ agentsDir: join(worktreePath, ".agents") });
    const report = bus.readArtifact("review-report.md");
    if (report) {
      parts.push(`### Review Report\n${report}`);
    }
  }

  // Test results for test phase
  if (phase === "test") {
    const bus = new AgentBus({ agentsDir: join(worktreePath, ".agents") });
    const results = bus.readArtifact("test-results.json");
    if (results) {
      parts.push(`### Test Results\n\`\`\`json\n${results}\n\`\`\``);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
