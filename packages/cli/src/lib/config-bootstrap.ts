/**
 * Config bootstrap helpers — auto-create `agent-orchestrator.yaml` on first run,
 * add new projects to an existing config, and read/write per-project behavior
 * config (orchestrator/worker agent overrides stored alongside the repo).
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import chalk from "chalk";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  loadConfig,
  generateSessionPrefix,
  getGlobalConfigPath,
  loadLocalProjectConfigDetailed,
  registerProjectInGlobalConfig,
  writeLocalProjectConfig,
  type OrchestratorConfig,
  type LocalProjectConfig,
} from "@aoagents/ao-core";
import { execSilent, git } from "./shell.js";
import { findFreePort } from "./web-dir.js";
import { detectEnvironment } from "./detect-env.js";
import { detectAgentRuntime, detectAvailableAgents } from "./detect-agent.js";
import { detectDefaultBranch } from "./git-utils.js";
import { promptText } from "./prompts.js";
import { extractOwnerRepo, isValidRepoString } from "./repo-utils.js";
import {
  detectProjectType,
  generateRulesFromTemplates,
  formatProjectTypeForDisplay,
} from "./project-detection.js";
import { isHumanCaller } from "./caller-context.js";
import { DEFAULT_PORT } from "./constants.js";
import {
  askYesNo,
  ensureGit,
  ghInstallAttempts,
  tryInstallWithAttempts,
} from "./installer.js";
import { promptInstallAgentRuntime } from "./agent-install-prompts.js";

export function isCanonicalGlobalConfigPath(configPath: string | undefined): boolean {
  if (!configPath) return false;
  return resolve(configPath) === resolve(getGlobalConfigPath());
}

/**
 * Clone an existing project entry under a fresh, unique project id + session prefix.
 * Used when `ao start` detects a running instance and the user opts to spawn
 * a new orchestrator for the same project (can't reuse the id or prefix).
 */
export function addDuplicateProjectToConfig(
  config: OrchestratorConfig,
  sourceProjectId: string,
): string {
  const rawYaml = readFileSync(config.configPath, "utf-8");
  const rawConfig = yamlParse(rawYaml);

  // Collect existing prefixes to avoid collisions
  const existingPrefixes = new Set(
    Object.values(rawConfig.projects as Record<string, Record<string, unknown>>)
      .map((p) => p.sessionPrefix as string)
      .filter(Boolean),
  );

  let newId: string;
  let newPrefix: string;
  do {
    const suffix = Math.random().toString(36).slice(2, 6);
    newId = `${sourceProjectId}-${suffix}`;
    newPrefix = generateSessionPrefix(newId);
  } while (rawConfig.projects[newId] || existingPrefixes.has(newPrefix));

  rawConfig.projects[newId] = {
    ...rawConfig.projects[sourceProjectId],
    sessionPrefix: newPrefix,
  };
  writeFileSync(config.configPath, yamlStringify(rawConfig, { indent: 2 }));
  console.log(chalk.green(`\n✓ New orchestrator "${newId}" added to config\n`));
  return newId;
}

/**
 * Persist the user's orchestrator/worker agent choices.
 * When the config path is the canonical global config, write to the per-project
 * `agent-orchestrator.yaml` beside the repo (so overrides are local to the
 * checkout). Otherwise, rewrite the in-place YAML.
 */
export function saveAgentOverride(
  configPath: string,
  projectId: string,
  projectPath: string,
  override: { orchestratorAgent: string; workerAgent: string },
): void {
  const { orchestratorAgent, workerAgent } = override;

  if (isCanonicalGlobalConfigPath(configPath)) {
    const nextLocalConfig = readProjectBehaviorConfig(projectPath);
    nextLocalConfig.orchestrator = {
      ...(nextLocalConfig.orchestrator ?? {}),
      agent: orchestratorAgent,
    };
    nextLocalConfig.worker = {
      ...(nextLocalConfig.worker ?? {}),
      agent: workerAgent,
    };
    writeProjectBehaviorConfig(projectPath, nextLocalConfig);
    console.log(chalk.dim(`  ✓ Saved to ${projectPath}/agent-orchestrator.yaml\n`));
  } else {
    const rawYaml = readFileSync(configPath, "utf-8");
    const rawConfig = yamlParse(rawYaml);
    const proj = rawConfig.projects?.[projectId];
    if (!proj) {
      throw new Error(
        `Project "${projectId}" not found in ${configPath}. The config may have been modified externally.`,
      );
    }
    proj.orchestrator = { ...(proj.orchestrator ?? {}), agent: orchestratorAgent };
    proj.worker = { ...(proj.worker ?? {}), agent: workerAgent };
    writeFileSync(configPath, yamlStringify(rawConfig, { indent: 2 }));
    console.log(chalk.dim(`  ✓ Saved to ${configPath}\n`));
  }
}

export function readProjectBehaviorConfig(projectPath: string): LocalProjectConfig {
  const localConfig = loadLocalProjectConfigDetailed(projectPath);
  if (localConfig.kind === "loaded") {
    return { ...localConfig.config };
  }
  return {};
}

export function writeProjectBehaviorConfig(projectPath: string, config: LocalProjectConfig): void {
  writeLocalProjectConfig(projectPath, config);
}

/**
 * Auto-create agent-orchestrator.yaml when no config exists.
 * Detects environment, project type, and generates config with smart defaults.
 * Returns the loaded config.
 */
export async function autoCreateConfig(workingDir: string): Promise<OrchestratorConfig> {
  console.log(chalk.bold.cyan("\n  Agent Orchestrator — First Run Setup\n"));
  console.log(chalk.dim("  Detecting project and generating config...\n"));

  const env = await detectEnvironment(workingDir);

  if (!env.isGitRepo) {
    throw new Error(
      `"${workingDir}" is not a git repository.\n` +
        `  ao requires a git repo to manage worktrees and branches.\n` +
        `  Run \`git init\` first, then try again.`,
    );
  }

  const projectType = detectProjectType(workingDir);

  // Show detection results
  if (env.isGitRepo) {
    console.log(chalk.green("  ✓ Git repository detected"));
    if (env.ownerRepo) {
      console.log(chalk.dim(`    Remote: ${env.ownerRepo}`));
    }
    if (env.currentBranch) {
      console.log(chalk.dim(`    Branch: ${env.currentBranch}`));
    }
  }

  if (projectType.languages.length > 0 || projectType.frameworks.length > 0) {
    console.log(chalk.green("  ✓ Project type detected"));
    const formattedType = formatProjectTypeForDisplay(projectType);
    formattedType.split("\n").forEach((line) => {
      console.log(chalk.dim(`    ${line}`));
    });
  }

  console.log();

  const agentRules = generateRulesFromTemplates(projectType);

  // Build config with smart defaults
  const projectId = basename(workingDir);
  let repo: string | undefined = env.ownerRepo ?? undefined;
  const path = workingDir;
  const defaultBranch = env.defaultBranch || "main";

  // If no repo detected, inform the user and ask
  /* c8 ignore start -- interactive prompt, tested via onboarding integration */
  if (!repo && isHumanCaller()) {
    console.log(chalk.yellow("  ⚠ Could not auto-detect a GitHub/GitLab remote."));
    const entered = await promptText(
      "  Enter repo (owner/repo or group/subgroup/repo) or leave empty to skip:",
      "owner/repo",
    );
    const trimmed = (entered || "").trim();
    if (trimmed && isValidRepoString(trimmed)) {
      repo = trimmed;
      console.log(chalk.green(`  ✓ Repo: ${repo}`));
    } else if (trimmed) {
      console.log(chalk.yellow(`  ⚠ "${trimmed}" doesn't look like a valid repo path — skipping.`));
    }
  }
  /* c8 ignore stop */

  // Detect available agent runtimes via plugin registry
  let detectedAgents = await detectAvailableAgents();
  detectedAgents = await promptInstallAgentRuntime(detectedAgents);
  const agent = await detectAgentRuntime(detectedAgents);
  console.log(chalk.green(`  ✓ Agent runtime: ${agent}`));

  const port = await findFreePort(DEFAULT_PORT);
  if (port !== null && port !== DEFAULT_PORT) {
    console.log(chalk.yellow(`  ⚠ Port ${DEFAULT_PORT} is busy — using ${port} instead.`));
  }

  const config: Record<string, unknown> = {
    port: port ?? DEFAULT_PORT,
    defaults: {
      runtime: "tmux",
      agent,
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      [projectId]: {
        name: projectId,
        sessionPrefix: generateSessionPrefix(projectId),
        ...(repo ? { repo } : {}),
        path,
        defaultBranch,
        ...(agentRules ? { agentRules } : {}),
      },
    },
  };

  const outputPath = resolve(workingDir, "agent-orchestrator.yaml");
  if (existsSync(outputPath)) {
    console.log(chalk.yellow(`⚠ Config already exists: ${outputPath}`));
    console.log(chalk.dim("  Use 'ao start' to start with the existing config.\n"));
    return loadConfig(outputPath);
  }
  const yamlContent = yamlStringify(config, { indent: 2 });
  writeFileSync(outputPath, yamlContent);

  console.log(chalk.green(`✓ Config created: ${outputPath}\n`));

  if (!repo) {
    console.log(chalk.yellow("⚠ No repo configured — issue tracking and PR features will be unavailable."));
    console.log(chalk.dim("  Add a 'repo' field (owner/repo) to the config to enable them.\n"));
  }

  if (!env.hasTmux) {
    console.log(chalk.yellow("⚠ tmux not found — will prompt to install at startup"));
  }
  if (!env.hasGh) {
    console.log(chalk.yellow("⚠ GitHub CLI (gh) not found — optional, but recommended for GitHub workflows."));
    const shouldInstallGh = await askYesNo("Install GitHub CLI now?", false);
    if (shouldInstallGh) {
      const installedGh = await tryInstallWithAttempts(
        ghInstallAttempts(),
        async () => (await execSilent("gh", ["--version"])) !== null,
      );
      if (installedGh) {
        env.hasGh = true;
        console.log(chalk.green("  ✓ GitHub CLI installed successfully"));
      } else {
        console.log(chalk.yellow("  ⚠ Could not install GitHub CLI automatically."));
      }
    }
  }
  if (!env.ghAuthed && env.hasGh) {
    console.log(chalk.yellow("⚠ GitHub CLI not authenticated — run: gh auth login"));
  }

  return loadConfig(outputPath);
}

/**
 * Add a new project to an existing config.
 * Detects git info, project type, generates rules, appends to config YAML.
 * Returns the project ID that was added.
 */
export async function addProjectToConfig(
  config: OrchestratorConfig,
  projectPath: string,
): Promise<string> {
  const resolvedPath = resolve(projectPath.replace(/^~/, process.env["HOME"] || ""));

  // Check if this path is already registered under any project name.
  // Use realpathSync for canonical comparison (resolves symlinks, case variants).
  // Done before ensureGit so already-registered paths return early without requiring git.
  const canonicalPath = realpathSync(resolvedPath);
  const existingByPath = Object.entries(config.projects).find(([, p]) => {
    try {
      return realpathSync(resolve(p.path.replace(/^~/, process.env["HOME"] || ""))) === canonicalPath;
    } catch {
      return false;
    }
  });
  if (existingByPath) {
    console.log(chalk.dim(`  Path already configured as project "${existingByPath[0]}" — skipping add.`));
    return existingByPath[0];
  }

  await ensureGit("adding projects");

  let projectId = basename(resolvedPath);

  // Avoid overwriting an existing project with the same directory name
  if (config.projects[projectId]) {
    let i = 2;
    while (config.projects[`${projectId}-${i}`]) i++;
    const newId = `${projectId}-${i}`;
    console.log(chalk.yellow(`  ⚠ Project "${projectId}" already exists — using "${newId}" instead.`));
    projectId = newId;
  }

  console.log(chalk.dim(`\n  Adding project "${projectId}"...\n`));

  // Validate git repo
  const isGitRepo = (await git(["rev-parse", "--git-dir"], resolvedPath)) !== null;
  if (!isGitRepo) {
    throw new Error(`"${resolvedPath}" is not a git repository.`);
  }

  // Detect git remote
  let ownerRepo: string | null = null;
  const gitRemote = await git(["remote", "get-url", "origin"], resolvedPath);
  if (gitRemote) {
    ownerRepo = extractOwnerRepo(gitRemote);
  }

  // If no repo detected, prompt the user (same as autoCreateConfig)
  /* c8 ignore start -- interactive prompt */
  if (!ownerRepo && isHumanCaller()) {
    console.log(chalk.yellow("  ⚠ Could not auto-detect a GitHub/GitLab remote."));
    const entered = await promptText(
      "  Enter repo (owner/repo or group/subgroup/repo) or leave empty to skip:",
      "owner/repo",
    );
    const trimmed = (entered || "").trim();
    if (trimmed && isValidRepoString(trimmed)) {
      ownerRepo = trimmed;
      console.log(chalk.green(`  ✓ Repo: ${ownerRepo}`));
    } else if (trimmed) {
      console.log(chalk.yellow(`  ⚠ "${trimmed}" doesn't look like a valid repo path — skipping.`));
    }
  }
  /* c8 ignore stop */

  const defaultBranch = await detectDefaultBranch(resolvedPath, ownerRepo);

  // Generate unique session prefix
  let prefix = generateSessionPrefix(projectId);
  const existingPrefixes = new Set(
    Object.values(config.projects).map(
      (p) => p.sessionPrefix || generateSessionPrefix(basename(p.path)),
    ),
  );
  if (existingPrefixes.has(prefix)) {
    let i = 2;
    while (existingPrefixes.has(`${prefix}${i}`)) i++;
    prefix = `${prefix}${i}`;
  }

  // Detect project type and generate rules
  const projectType = detectProjectType(resolvedPath);
  const agentRules = generateRulesFromTemplates(projectType);

  // Show what was detected
  console.log(chalk.green(`  ✓ Git repository`));
  if (ownerRepo) {
    console.log(chalk.dim(`    Remote: ${ownerRepo}`));
  }
  console.log(chalk.dim(`    Default branch: ${defaultBranch}`));
  console.log(chalk.dim(`    Session prefix: ${prefix}`));

  if (projectType.languages.length > 0 || projectType.frameworks.length > 0) {
    console.log(chalk.green("  ✓ Project type detected"));
    const formattedType = formatProjectTypeForDisplay(projectType);
    formattedType.split("\n").forEach((line) => {
      console.log(chalk.dim(`    ${line}`));
    });
  }

  if (isCanonicalGlobalConfigPath(config.configPath)) {
    registerProjectInGlobalConfig(
      projectId,
      projectId,
      resolvedPath,
      { defaultBranch, sessionPrefix: prefix },
      config.configPath,
    );

    writeProjectBehaviorConfig(
      resolvedPath,
      agentRules ? { agentRules } : {},
    );

    console.log(chalk.green(`\n✓ Added "${projectId}" to ${config.configPath}\n`));
  } else {
    // Load raw YAML, append project, rewrite
    const rawYaml = readFileSync(config.configPath, "utf-8");
    const rawConfig = yamlParse(rawYaml);
    if (!rawConfig.projects) rawConfig.projects = {};

    rawConfig.projects[projectId] = {
      name: projectId,
      ...(ownerRepo ? { repo: ownerRepo } : {}),
      path: resolvedPath,
      defaultBranch,
      sessionPrefix: prefix,
      ...(agentRules ? { agentRules } : {}),
    };

    writeFileSync(config.configPath, yamlStringify(rawConfig, { indent: 2 }));
    console.log(chalk.green(`\n✓ Added "${projectId}" to ${config.configPath}\n`));
  }

  if (!ownerRepo) {
    console.log(chalk.yellow("⚠ No repo configured — issue tracking and PR features will be unavailable."));
    console.log(chalk.dim("  Add a 'repo' field (owner/repo) to the config to enable them.\n"));
  }

  return projectId;
}
