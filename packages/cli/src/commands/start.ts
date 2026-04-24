/**
 * `ao start` and `ao stop` commands — unified orchestrator startup.
 *
 * Supports two modes:
 *   1. `ao start [project]` — start from existing config
 *   2. `ao start <url>` — clone repo, auto-generate config, then start
 *
 * The orchestrator prompt is passed to the agent via --append-system-prompt
 * (or equivalent flag) at launch time — no file writing required.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { cwd } from "node:process";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  generateOrchestratorPrompt,
  generateSessionPrefix,
  getOrchestratorSessionId,
  findConfigFile,
  getGlobalConfigPath,
  isRepoUrl,
  parseRepoUrl,
  resolveCloneTarget,
  isRepoAlreadyCloned,
  generateConfigFromUrl,
  configToYaml,
  isOrchestratorSession,
  isTerminalSession,
  ConfigNotFoundError,
  loadLocalProjectConfigDetailed,
  registerProjectInGlobalConfig,
  type OrchestratorConfig,
  type LocalProjectConfig,
  type ProjectConfig,
  type ParsedRepoUrl,
  writeLocalProjectConfig,
} from "@aoagents/ao-core";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { exec, execSilent, git } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker, stopAllLifecycleWorkers } from "../lib/lifecycle-service.js";
import {
  findWebDir,
  buildDashboardEnv,
  waitForPortAndOpen,
  openUrl,
  isPortAvailable,
  findFreePort,
  MAX_PORT_SCAN,
} from "../lib/web-dir.js";
import { rebuildDashboardProductionArtifacts } from "../lib/dashboard-rebuild.js";
import { preflight } from "../lib/preflight.js";
import {
  register,
  unregister,
  isAlreadyRunning,
  getRunning,
  waitForExit,
  acquireStartupLock,
} from "../lib/running-state.js";
import { preventIdleSleep } from "../lib/prevent-sleep.js";
import { isHumanCaller } from "../lib/caller-context.js";
import { detectEnvironment } from "../lib/detect-env.js";
import { detectAgentRuntime, detectAvailableAgents, type DetectedAgent } from "../lib/detect-agent.js";
import { detectDefaultBranch } from "../lib/git-utils.js";
import { promptConfirm, promptSelect, promptText } from "../lib/prompts.js";
import { extractOwnerRepo, isValidRepoString } from "../lib/repo-utils.js";
import {
  detectProjectType,
  generateRulesFromTemplates,
  formatProjectTypeForDisplay,
} from "../lib/project-detection.js";
import { formatCommandError } from "../lib/cli-errors.js";
import { detectOpenClawInstallation } from "../lib/openclaw-probe.js";
import { applyOpenClawCredentials } from "../lib/credential-resolver.js";
import { findProjectForDirectory } from "../lib/project-resolution.js";

import { DEFAULT_PORT } from "../lib/constants.js";
import { projectSessionUrl } from "../lib/routes.js";

// =============================================================================
// HELPERS
// =============================================================================

function isCanonicalGlobalConfigPath(configPath: string | undefined): boolean {
  if (!configPath) return false;
  return resolve(configPath) === resolve(getGlobalConfigPath());
}

function readProjectBehaviorConfig(projectPath: string): LocalProjectConfig {
  const localConfig = loadLocalProjectConfigDetailed(projectPath);
  if (localConfig.kind === "loaded") {
    return { ...localConfig.config };
  }
  return {};
}

function writeProjectBehaviorConfig(projectPath: string, config: LocalProjectConfig): void {
  writeLocalProjectConfig(projectPath, config);
}

/**
 * Resolve project from config.
 * If projectArg is provided, use it. If only one project exists, use that.
 * Otherwise, error with helpful message.
 */
async function resolveProject(
  config: OrchestratorConfig,
  projectArg?: string,
  action = "start",
): Promise<{ projectId: string; project: ProjectConfig }> {
  const projectIds = Object.keys(config.projects);

  if (projectIds.length === 0) {
    throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
  }

  // Explicit project argument
  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, project };
  }

  // Only one project — use it
  if (projectIds.length === 1) {
    const projectId = projectIds[0];
    return { projectId, project: config.projects[projectId] };
  }

  // Multiple projects — try matching cwd to a project path
  // Note: loadConfig() already expands ~ in project paths via expandPaths()
  const currentDir = resolve(cwd());
  const matchedProjectId = findProjectForDirectory(config.projects, currentDir);
  if (matchedProjectId) {
    return { projectId: matchedProjectId, project: config.projects[matchedProjectId] };
  }

  // No match — prompt if interactive, otherwise error
  if (isHumanCaller()) {
    const projectId = await promptSelect(
      `Choose project to ${action}:`,
      projectIds.map((id) => ({
        value: id,
        label: config.projects[id].name ?? id,
        hint: id,
      })),
    );
    return { projectId, project: config.projects[projectId] };
  } else {
    throw new Error(
      `Multiple projects configured. Specify which one to ${action}:\n  ${projectIds.map((id) => `ao ${action} ${id}`).join("\n  ")}`,
    );
  }
}

/**
 * Resolve project from config by matching against a repo URL's ownerRepo.
 * Used when `ao start <url>` loads an existing multi-project config — the user
 * can't pass both a URL and a project name since they share the same arg slot.
 *
 * Falls back to `resolveProject` (which handles single-project configs or
 * errors with a helpful message for ambiguous multi-project cases).
 */
async function resolveProjectByRepo(
  config: OrchestratorConfig,
  parsed: ParsedRepoUrl,
): Promise<{ projectId: string; project: ProjectConfig }> {
  const projectIds = Object.keys(config.projects);

  // Try to match by repo field (e.g. "owner/repo")
  for (const id of projectIds) {
    const project = config.projects[id];
    if (project.repo === parsed.ownerRepo) {
      return { projectId: id, project };
    }
  }

  // No repo match — fall back to standard resolution (works for single-project)
  return await resolveProject(config);
}

interface InstallAttempt {
  cmd: string;
  args: string[];
  label: string;
}

function canPromptForInstall(): boolean {
  return isHumanCaller() && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function genericInstallHints(command: string): string[] {
  switch (command) {
    case "node":
    case "npm":
      return ["Install Node.js/npm from https://nodejs.org/"];
    case "pnpm":
      return [
        "corepack enable && corepack prepare pnpm@latest --activate",
        "npm install -g pnpm",
      ];
    case "pipx":
      return [
        "python3 -m pip install --user pipx",
        "python3 -m pipx ensurepath",
      ];
    default:
      return [];
  }
}

/**
 * Prompt the user to optionally switch orchestrator/worker agents at startup.
 * Shows only agents detected on the current system (reuses detectAvailableAgents).
 * Returns the chosen agents
 */
async function promptAgentSelection(): Promise<{
  orchestratorAgent: string;
  workerAgent: string
} | null> {
  if (canPromptForInstall()) {
    const available = await detectAvailableAgents();
    if (available.length === 0) {
      console.log(chalk.yellow("No agent runtimes detected — using existing config."));
      return null;
    }

    const agentOptions = available.map((a) => ({ value: a.name, label: a.displayName }));

    const orchestratorAgent = await promptSelect("Orchestrator agent:", agentOptions);
    const workerAgent = await promptSelect("Worker agent:", agentOptions);

    return { orchestratorAgent, workerAgent };
  } else {
    return null;
  }
}

async function askYesNo(
  question: string,
  defaultYes = true,
  nonInteractiveDefault = defaultYes,
): Promise<boolean> {
  if (!canPromptForInstall()) return nonInteractiveDefault;
  return await promptConfirm(question, defaultYes);
}

function gitInstallAttempts(): InstallAttempt[] {
  if (process.platform === "darwin") {
    return [{ cmd: "brew", args: ["install", "git"], label: "brew install git" }];
  }
  if (process.platform === "linux") {
    return [
      { cmd: "sudo", args: ["apt-get", "install", "-y", "git"], label: "sudo apt-get install -y git" },
      { cmd: "sudo", args: ["dnf", "install", "-y", "git"], label: "sudo dnf install -y git" },
    ];
  }
  if (process.platform === "win32") {
    return [
      {
        cmd: "winget",
        args: ["install", "--id", "Git.Git", "-e", "--source", "winget"],
        label: "winget install --id Git.Git -e --source winget",
      },
    ];
  }
  return [];
}

function gitInstallHints(): string[] {
  if (process.platform === "darwin") return ["brew install git"];
  if (process.platform === "win32") return ["winget install --id Git.Git -e --source winget"];
  return [
    "sudo apt install git      # Debian/Ubuntu",
    "sudo dnf install git      # Fedora/RHEL",
  ];
}

function ghInstallAttempts(): InstallAttempt[] {
  if (process.platform === "darwin") {
    return [{ cmd: "brew", args: ["install", "gh"], label: "brew install gh" }];
  }
  if (process.platform === "linux") {
    return [
      { cmd: "sudo", args: ["apt-get", "install", "-y", "gh"], label: "sudo apt-get install -y gh" },
      { cmd: "sudo", args: ["dnf", "install", "-y", "gh"], label: "sudo dnf install -y gh" },
    ];
  }
  if (process.platform === "win32") {
    return [
      {
        cmd: "winget",
        args: ["install", "--id", "GitHub.cli", "-e", "--source", "winget"],
        label: "winget install --id GitHub.cli -e --source winget",
      },
    ];
  }
  return [];
}

async function runInteractiveCommand(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.once("error", (err) => {
      reject(
        formatCommandError(err, {
          cmd,
          args,
          action: "run an interactive installer",
          installHints: genericInstallHints(cmd),
        }),
      );
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code ?? "unknown"}): ${cmd} ${args.join(" ")}`));
    });
  });
}

async function tryInstallWithAttempts(
  attempts: InstallAttempt[],
  verify: () => Promise<boolean>,
): Promise<boolean> {
  for (const attempt of attempts) {
    try {
      console.log(chalk.dim(`  Running: ${attempt.label}`));
      await runInteractiveCommand(attempt.cmd, attempt.args);
      if (await verify()) return true;
    } catch {
      // Try next installer
    }
  }
  return verify();
}

async function ensureGit(context: string): Promise<void> {
  const hasGit = (await execSilent("git", ["--version"])) !== null;
  if (hasGit) return;

  console.log(chalk.yellow(`⚠ Git is required for ${context}.`));
  const shouldInstall = await askYesNo("Install Git now?", true, false);
  if (shouldInstall) {
    const installed = await tryInstallWithAttempts(
      gitInstallAttempts(),
      async () => (await execSilent("git", ["--version"])) !== null,
    );
    if (installed) {
      console.log(chalk.green("  ✓ Git installed successfully"));
      return;
    }
  }

  console.error(chalk.red("\n✗ Git is required but is not installed.\n"));
  console.log(chalk.bold("  Install Git manually, then re-run ao start:\n"));
  for (const hint of gitInstallHints()) {
    console.log(chalk.cyan(`    ${hint}`));
  }
  console.log();
  process.exit(1);
}

interface AgentInstallOption {
  id: string;
  label: string;
  cmd: string;
  args: string[];
}

const AGENT_INSTALL_OPTIONS: AgentInstallOption[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    cmd: "npm",
    args: ["install", "-g", "@anthropic-ai/claude-code"],
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    cmd: "npm",
    args: ["install", "-g", "@openai/codex"],
  },
  {
    id: "aider",
    label: "Aider",
    cmd: "pipx",
    args: ["install", "aider-chat"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    cmd: "npm",
    args: ["install", "-g", "opencode-ai"],
  },
];

async function promptInstallAgentRuntime(available: DetectedAgent[]): Promise<DetectedAgent[]> {
  if (available.length > 0 || !canPromptForInstall()) return available;

  console.log(chalk.yellow("⚠ No supported agent runtime detected."));
  console.log(chalk.dim("  You can install one now (recommended) or continue and install later.\n"));
  const choice = await promptSelect(
    "Choose runtime to install:",
    [
      ...AGENT_INSTALL_OPTIONS.map((option) => ({
        value: option.id,
        label: option.label,
        hint: [option.cmd, ...option.args].join(" "),
      })),
      { value: "skip", label: "Skip for now" },
    ],
  );
  if (choice === "skip") {
    return available;
  }

  const selected = AGENT_INSTALL_OPTIONS.find((option) => option.id === choice);
  if (!selected) {
    return available;
  }

  console.log(chalk.dim(`  Installing ${selected.label}...`));
  try {
    await runInteractiveCommand(selected.cmd, selected.args);
    const refreshed = await detectAvailableAgents();
    if (refreshed.length > 0) {
      console.log(chalk.green(`  ✓ ${selected.label} installed successfully`));
    }
    return refreshed;
  } catch {
    console.log(chalk.yellow(`  ⚠ Could not install ${selected.label} automatically.`));
    return available;
  }
}

/**
 * Clone a repo with authentication support.
 *
 * Strategy:
 *   1. Try `gh repo clone owner/repo target -- --depth 1` — handles GitHub auth
 *      for private repos via the user's `gh auth` token.
 *   2. Fall back to `git clone --depth 1` with SSH URL — works for users with
 *      SSH keys configured (common for private repos without gh).
 *   3. Final fallback to `git clone --depth 1` with HTTPS URL — works for
 *      public repos without any auth setup.
 */
async function cloneRepo(parsed: ParsedRepoUrl, targetDir: string, cwd: string): Promise<void> {
  // 1. Try gh repo clone (handles GitHub auth automatically)
  if (parsed.host === "github.com") {
    const ghAvailable = (await execSilent("gh", ["auth", "status"])) !== null;
    if (ghAvailable) {
      try {
        await exec("gh", ["repo", "clone", parsed.ownerRepo, targetDir, "--", "--depth", "1"], {
          cwd,
        });
        return;
      } catch {
        // gh clone failed — fall through to git clone with SSH
      }
    }
  }

  // 2. Try git clone with SSH URL (works with SSH keys for private repos)
  const sshUrl = `git@${parsed.host}:${parsed.ownerRepo}.git`;
  try {
    await exec("git", ["clone", "--depth", "1", sshUrl, targetDir], { cwd });
    return;
  } catch {
    // SSH failed — fall through to HTTPS
  }

  // 3. Final fallback: HTTPS (works for public repos)
  await exec("git", ["clone", "--depth", "1", parsed.cloneUrl, targetDir], { cwd });
}

/**
 * Handle `ao start <url>` — clone repo, generate config, return loaded config.
 * Also returns the parsed URL so the caller can match by repo when the config
 * contains multiple projects.
 */
async function handleUrlStart(
  url: string,
): Promise<{ config: OrchestratorConfig; parsed: ParsedRepoUrl; autoGenerated: boolean }> {
  const spinner = ora();

  // 1. Parse URL
  spinner.start("Parsing repository URL");
  const parsed = parseRepoUrl(url);
  spinner.succeed(`Repository: ${chalk.cyan(parsed.ownerRepo)} (${parsed.host})`);

  await ensureGit("repository cloning");

  // 2. Determine target directory
  const cwd = process.cwd();
  const targetDir = resolveCloneTarget(parsed, cwd);
  const alreadyCloned = isRepoAlreadyCloned(targetDir, parsed.cloneUrl);

  // 3. Clone or reuse
  if (alreadyCloned) {
    console.log(chalk.green(`  Reusing existing clone at ${targetDir}`));
  } else {
    spinner.start(`Cloning ${parsed.ownerRepo}`);
    try {
      await cloneRepo(parsed, targetDir, cwd);
      spinner.succeed(`Cloned to ${targetDir}`);
    } catch (err) {
      spinner.fail("Clone failed");
      throw new Error(
        `Failed to clone ${parsed.ownerRepo}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // 4. Check for existing config
  const configPath = resolve(targetDir, "agent-orchestrator.yaml");
  const configPathAlt = resolve(targetDir, "agent-orchestrator.yml");

  if (existsSync(configPath)) {
    console.log(chalk.green(`  Using existing config: ${configPath}`));
    return { config: loadConfig(configPath), parsed, autoGenerated: false };
  }

  if (existsSync(configPathAlt)) {
    console.log(chalk.green(`  Using existing config: ${configPathAlt}`));
    return { config: loadConfig(configPathAlt), parsed, autoGenerated: false };
  }

  // 5. Auto-generate config with a free port
  spinner.start("Generating config");
  const freePort = await findFreePort(DEFAULT_PORT);
  const rawConfig = generateConfigFromUrl({
    parsed,
    repoPath: targetDir,
    port: freePort ?? DEFAULT_PORT,
  });

  const yamlContent = configToYaml(rawConfig);
  writeFileSync(configPath, yamlContent);
  spinner.succeed(`Config generated: ${configPath}`);

  return { config: loadConfig(configPath), parsed, autoGenerated: true };
}

/**
 * Auto-create agent-orchestrator.yaml when no config exists.
 * Detects environment, project type, and generates config with smart defaults.
 * Returns the loaded config.
 */
async function autoCreateConfig(workingDir: string): Promise<OrchestratorConfig> {
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
async function addProjectToConfig(
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

/**
 * Create config without starting dashboard/orchestrator.
 * Used by deprecated `ao init` wrapper.
 */
export async function createConfigOnly(): Promise<void> {
  await autoCreateConfig(cwd());
}

/**
 * Start dashboard server in the background.
 * Returns the child process handle for cleanup.
 */
/* c8 ignore start -- process-spawning startup code, tested via integration/onboarding */
async function startDashboard(
  port: number,
  webDir: string,
  configPath: string | null,
  terminalPort?: number,
  directTerminalPort?: number,
  devMode?: boolean,
): Promise<ChildProcess> {
  const env = await buildDashboardEnv(port, configPath, terminalPort, directTerminalPort);

  // Detect monorepo vs npm install: the `server/` source directory only exists
  // in the monorepo. Published npm packages only have `dist-server/`.
  const isMonorepo = existsSync(resolve(webDir, "server"));

  // In monorepo: use HMR dev server only when --dev is passed explicitly.
  // Default is optimized production server for faster loading.
  const useDevServer = isMonorepo && devMode === true;

  let child: ChildProcess;
  if (useDevServer) {
    // Monorepo with --dev: use pnpm run dev (tsx watch, HMR, etc.)
    console.log(chalk.dim("  Mode: development (HMR enabled)"));
    child = spawn("pnpm", ["run", "dev"], {
      cwd: webDir,
      stdio: "inherit",
      detached: false,
      env,
    });
  } else {
    // Production: use pre-built start-all script.
    if (isMonorepo) {
      console.log(chalk.dim("  Mode: optimized (production bundles)"));
      console.log(chalk.dim("  Tip: use --dev for hot reload when editing dashboard UI\n"));
    }
    const startScript = resolve(webDir, "dist-server", "start-all.js");
    child = spawn("node", [startScript], {
      cwd: webDir,
      stdio: "inherit",
      detached: false,
      env,
    });
  }

  child.on("error", (err) => {
    const cmd = useDevServer ? "pnpm" : "node";
    const args = useDevServer ? ["run", "dev"] : [resolve(webDir, "dist-server", "start-all.js")];
    const formatted = formatCommandError(err, {
      cmd,
      args,
      action: "start the AO dashboard",
      installHints: genericInstallHints(cmd),
    });
    console.error(chalk.red("Dashboard failed to start:"), formatted.message);
    // Emit synthetic exit so callers listening on "exit" can clean up
    child.emit("exit", 1, null);
  });

  return child;
}
/* c8 ignore stop */

/**
 * Ensure tmux is available — interactive install with user consent if missing.
 * Called from runStartup() so ALL ao start
 * paths (normal, URL, retry with existing config) are covered.
 */
function tmuxInstallAttempts(): InstallAttempt[] {
  if (process.platform === "darwin") {
    return [{ cmd: "brew", args: ["install", "tmux"], label: "brew install tmux" }];
  }
  if (process.platform === "linux") {
    return [
      { cmd: "sudo", args: ["apt-get", "install", "-y", "tmux"], label: "sudo apt-get install -y tmux" },
      { cmd: "sudo", args: ["dnf", "install", "-y", "tmux"], label: "sudo dnf install -y tmux" },
    ];
  }
  return [];
}

function tmuxInstallHints(): string[] {
  if (process.platform === "darwin") return ["brew install tmux"];
  if (process.platform === "win32") return [
    "# Install WSL first, then inside WSL:",
    "sudo apt install tmux",
  ];
  return [
    "sudo apt install tmux      # Debian/Ubuntu",
    "sudo dnf install tmux      # Fedora/RHEL",
  ];
}

async function ensureTmux(): Promise<void> {
  const hasTmux = (await execSilent("tmux", ["-V"])) !== null;
  if (hasTmux) return;

  console.log(chalk.yellow("⚠ tmux is required for runtime \"tmux\"."));
  const shouldInstall = await askYesNo("Install tmux now?", true, false);
  if (shouldInstall) {
    const installed = await tryInstallWithAttempts(
      tmuxInstallAttempts(),
      async () => (await execSilent("tmux", ["-V"])) !== null,
    );
    if (installed) {
      console.log(chalk.green("  ✓ tmux installed successfully"));
      return;
    }
  }

  console.error(chalk.red("\n✗ tmux is required but is not installed.\n"));
  console.log(chalk.bold("  Install tmux manually, then re-run ao start:\n"));
  for (const hint of tmuxInstallHints()) {
    console.log(chalk.cyan(`    ${hint}`));
  }
  console.log();
  process.exit(1);
}

async function warnAboutOpenClawStatus(config: OrchestratorConfig): Promise<void> {
  const openclawConfig = config.notifiers?.["openclaw"];
  const openclawConfigured =
    openclawConfig !== null && openclawConfig !== undefined &&
    typeof openclawConfig === "object" &&
    openclawConfig.plugin === "openclaw";
  const configuredUrl =
    openclawConfigured && typeof openclawConfig.url === "string" ? openclawConfig.url : undefined;

  try {
    const installation = configuredUrl
      ? await detectOpenClawInstallation(configuredUrl)
      : await detectOpenClawInstallation();

    if (openclawConfigured) {
      if (installation.state !== "running") {
        console.log(
          chalk.yellow(
            `⚠ OpenClaw is configured but the gateway is not reachable at ${installation.gatewayUrl}. Notifications may fail until it is running.`,
          ),
        );
      }
      return;
    }

    if (installation.state === "running") {
      console.log(
        chalk.yellow(
          `⚠ OpenClaw is running at ${installation.gatewayUrl} but AO is not configured to use it. Run \`ao setup openclaw\` if you want OpenClaw notifications.`,
        ),
      );
    }
  } catch {
    // OpenClaw probing is advisory for `ao start`; never block startup on it.
  }
}

/**
 * Shared startup logic: launch dashboard + orchestrator session, print summary.
 * Used by both normal and URL-based start flows.
 */
async function runStartup(
  config: OrchestratorConfig,
  projectId: string,
  project: ProjectConfig,
  opts?: { dashboard?: boolean; orchestrator?: boolean; rebuild?: boolean; dev?: boolean },
): Promise<number> {
  // Ensure tmux is available before doing anything — covers all entry paths
  // (normal start, URL start, retry with existing config)
  const runtime = config.defaults?.runtime ?? "tmux";
  if (runtime === "tmux") {
    await ensureTmux();
  }
  await warnAboutOpenClawStatus(config);

  // Prevent macOS idle sleep while AO is running (if enabled in config)
  // Uses caffeinate -i -w <pid> to hold an assertion tied to this process lifetime.
  // No-op on non-macOS platforms.
  if (config.power?.preventIdleSleep !== false) {
    const sleepHandle = preventIdleSleep();
    if (sleepHandle) {
      console.log(chalk.dim("  Preventing macOS idle sleep while AO is running"));
    }
  }

  // Only inject OpenClaw credentials when the project actually uses OpenClaw.
  // This avoids exposing API keys to projects/plugins that don't need them.
  const openclawNotifier = config.notifiers?.["openclaw"];
  const hasOpenClaw =
    openclawNotifier !== null && openclawNotifier !== undefined &&
    typeof openclawNotifier === "object" && openclawNotifier.plugin === "openclaw";
  if (hasOpenClaw) {
    const injectedKeys = applyOpenClawCredentials();
    if (injectedKeys.length > 0) {
      const names = injectedKeys.map((k) => k.key).join(", ");
      console.log(chalk.dim(`  Resolved from OpenClaw config: ${names}`));
    }
  }

  const shouldStartLifecycle = opts?.dashboard !== false || opts?.orchestrator !== false;
  let lifecycleStatus: Awaited<ReturnType<typeof ensureLifecycleWorker>> | null = null;
  let port = config.port ?? DEFAULT_PORT;
  console.log(chalk.bold(`\nStarting orchestrator for ${chalk.cyan(project.name)}\n`));

  const spinner = ora();
  let dashboardProcess: ChildProcess | null = null;
  let restored = false;

  // Start dashboard (unless --no-dashboard)
  if (opts?.dashboard !== false) {
    if (!(await isPortAvailable(port))) {
      const newPort = await findFreePort(port + 1);
      if (newPort === null) {
        throw new Error(
          `Port ${port} is busy and no free port found in range ${port + 1}–${port + MAX_PORT_SCAN}. Free port ${port} or set a different 'port' in agent-orchestrator.yaml.`,
        );
      }
      console.log(chalk.yellow(`Port ${port} is busy — using ${newPort} instead.`));
      port = newPort;
    }
    const webDir = findWebDir(); // throws with install-specific guidance if not found
    // Dev mode (HMR) only works in the monorepo where `server/` source exists.
    // For npm installs, --dev is silently ignored and production server runs,
    // so preflight must still verify production artifacts exist.
    const isMonorepo = existsSync(resolve(webDir, "server"));
    const willUseDevServer = isMonorepo && opts?.dev === true;
    if (opts?.rebuild) {
      await rebuildDashboardProductionArtifacts(webDir);
    } else if (!willUseDevServer) {
      await preflight.checkBuilt(webDir);
    }

    spinner.start("Starting dashboard");
    dashboardProcess = await startDashboard(
      port,
      webDir,
      config.configPath,
      config.terminalPort,
      config.directTerminalPort,
      opts?.dev,
    );
    spinner.succeed(`Dashboard starting on http://localhost:${port}`);
    console.log(chalk.dim("  (Dashboard will be ready in a few seconds)\n"));
  }

  if (shouldStartLifecycle) {
    try {
      spinner.start("Starting lifecycle worker");
      lifecycleStatus = await ensureLifecycleWorker(config, projectId);
      spinner.succeed(
        lifecycleStatus.started
          ? "Lifecycle polling started"
          : "Lifecycle polling already running",
      );
    } catch (err) {
      spinner.fail("Lifecycle worker failed to start");
      if (dashboardProcess) {
        dashboardProcess.kill();
      }
      throw new Error(
        `Failed to start lifecycle worker: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  let selectedOrchestratorId: string | null = null;

  if (opts?.orchestrator !== false) {
    const sm = await getSessionManager(config);

    try {
      spinner.start("Ensuring orchestrator session");
      const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
      const before = await sm.get(getOrchestratorSessionId(project));
      const session = await sm.ensureOrchestrator({ projectId, systemPrompt });
      selectedOrchestratorId = session.id;
      restored = Boolean(session.restoredAt);
      if (before && session.id === before.id && !restored) {
        spinner.succeed(`Using orchestrator session: ${session.id}`);
      } else if (restored) {
        spinner.succeed(`Restored orchestrator session: ${session.id}`);
      } else {
        spinner.succeed(`Orchestrator session ready: ${session.id}`);
      }
    } catch (err) {
      spinner.fail("Orchestrator setup failed");
      if (dashboardProcess) {
        dashboardProcess.kill();
      }
      throw new Error(
        `Failed to setup orchestrator: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Print summary
  console.log(chalk.bold.green("\n✓ Startup complete\n"));

  if (opts?.dashboard !== false) {
    console.log(chalk.cyan("Dashboard:"), `http://localhost:${port}`);
  }

  if (shouldStartLifecycle && lifecycleStatus) {
    const lifecycleLabel = lifecycleStatus.started ? "started" : "already running";
    console.log(chalk.cyan("Lifecycle:"), lifecycleLabel);
  }

  if (opts?.orchestrator !== false && selectedOrchestratorId) {
    const restoreNote = restored ? " (restored)" : "";
    const target =
      opts?.dashboard !== false
        ? projectSessionUrl(port, projectId, selectedOrchestratorId)
        : `ao session attach ${selectedOrchestratorId}`;

    console.log(chalk.cyan("Orchestrator:"), `${target}${restoreNote}`);
  }

  console.log(chalk.dim(`Config: ${config.configPath}`));

  // Auto-open browser once the server is ready.
  // Navigate directly to the deterministic main orchestrator when one is available.
  // Polls the port instead of using a fixed delay — deterministic and works regardless of
  // how long Next.js takes to compile. AbortController cancels polling on early exit.
  let openAbort: AbortController | undefined;
  if (opts?.dashboard !== false) {
    openAbort = new AbortController();
    const orchestratorUrl = selectedOrchestratorId
      ? projectSessionUrl(port, projectId, selectedOrchestratorId)
      : `http://localhost:${port}`;
    void waitForPortAndOpen(port, orchestratorUrl, openAbort.signal);
  }

  // Keep dashboard process alive if it was started
  if (dashboardProcess) {
    // Kill the dashboard child when the parent exits for any reason
    // (Ctrl+C, SIGTERM from `ao stop`, normal exit, etc.).
    // We use the `exit` event instead of SIGINT/SIGTERM to avoid
    // conflicting with the shutdown handler in registerStart that
    // flushes lifecycle state and calls process.exit() with the
    // correct exit code (130 for SIGINT, 0 for SIGTERM).
    /* c8 ignore start -- exit handler only fires on process termination */
    const killDashboardChild = (): void => {
      try {
        dashboardProcess?.kill("SIGTERM");
      } catch {
        // already dead
      }
    };
    /* c8 ignore stop */
    process.on("exit", killDashboardChild);

    dashboardProcess.on("exit", (code) => {
      process.removeListener("exit", killDashboardChild);
      if (openAbort) openAbort.abort();
      if (code !== 0 && code !== null) {
        console.error(chalk.red(`Dashboard exited with code ${code}`));
      }
      process.exit(code ?? 0);
    });
  }

  return port;
}

/**
 * Stop dashboard server.
 * Uses lsof to find the process listening on the port, then kills it.
 * Best effort — if it fails, just warn the user.
 */
/** Pattern matching AO dashboard processes (production and dev mode). */
const DASHBOARD_CMD_PATTERN = /next-server|start-all\.js|next dev|ao-web/;

/**
 * Check whether a process listening on the given port is an AO dashboard
 * (next-server, start-all.js, or next dev).  Only kills matching PIDs,
 * leaving unrelated co-listeners (sidecars, SO_REUSEPORT) untouched.
 */
async function killDashboardOnPort(port: number): Promise<boolean> {
  try {
    const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
    const pids = stdout
      .trim()
      .split("\n")
      .filter((p) => p.length > 0);
    if (pids.length === 0) return false;

    // Filter to only dashboard PIDs
    const dashboardPids: string[] = [];
    for (const pid of pids) {
      try {
        const { stdout: cmdline } = await exec("ps", ["-p", pid, "-o", "args="]);
        if (DASHBOARD_CMD_PATTERN.test(cmdline)) {
          dashboardPids.push(pid);
        }
      } catch {
        // process vanished — skip
      }
    }
    if (dashboardPids.length === 0) return false;

    await exec("kill", dashboardPids);
    return true;
  } catch {
    return false;
  }
}

async function stopDashboard(port: number): Promise<void> {
  // 1. Try the expected port — verify it's a dashboard before killing
  if (await killDashboardOnPort(port)) {
    console.log(chalk.green("Dashboard stopped"));
    return;
  }

  // 2. Fallback: scan nearby ports to find an orphaned dashboard
  //    that was auto-reassigned when the original port was busy.
  //    Uses killDashboardOnPort to verify the process is actually an
  //    AO dashboard before killing, avoiding collateral damage.
  for (let p = port + 1; p <= port + MAX_PORT_SCAN; p++) {
    if (await killDashboardOnPort(p)) {
      console.log(chalk.green(`Dashboard stopped (was on port ${p})`));
      return;
    }
  }

  console.log(chalk.yellow("Could not stop dashboard (may not be running)"));
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerStart(program: Command): void {
  program
    .command("start [project]")
    .description(
      "Start orchestrator agent and dashboard (auto-creates config on first run, adds projects by path/URL)",
    )
    .option("--no-dashboard", "Skip starting the dashboard server")
    .option("--no-orchestrator", "Skip starting the orchestrator agent")
    .option("--rebuild", "Clean and rebuild dashboard before starting")
    .option("--dev", "Use Next.js dev server with hot reload (for dashboard UI development)")
    .option("--interactive", "Prompt to configure config settings")
    .action(
      async (
        projectArg?: string,
        opts?: {
          dashboard?: boolean;
          orchestrator?: boolean;
          rebuild?: boolean;
          dev?: boolean;
          interactive?: boolean;
        },
      ) => {
        let releaseStartupLock: (() => void) | undefined;
        let startupLockReleased = false;
        const unlockStartup = (): void => {
          if (startupLockReleased || !releaseStartupLock) return;
          startupLockReleased = true;
          releaseStartupLock();
        };

        try {
          releaseStartupLock = await acquireStartupLock();
          let config: OrchestratorConfig;
          let projectId: string;
          let project: ProjectConfig;

          // ── Already-running detection (before any config mutation) ──
          const running = await isAlreadyRunning();
          let startNewOrchestrator = false;
          if (running) {
            if (isHumanCaller()) {
              console.log(chalk.cyan(`\nℹ AO is already running.`));
              console.log(`  Dashboard: ${chalk.cyan(`http://localhost:${running.port}`)}`);
              console.log(`  PID: ${running.pid} | Up since: ${running.startedAt}`);
              console.log(`  Projects: ${running.projects.join(", ")}\n`);

              const choice = await promptSelect(
                "AO is already running. What do you want to do?",
                [
                  { value: "open", label: "Open dashboard", hint: "Keep the current instance" },
                  { value: "new", label: "Start new orchestrator", hint: "Add a new session for this project" },
                  { value: "restart", label: "Restart everything", hint: "Stop the current instance first" },
                  { value: "quit", label: "Quit" },
                ],
                "open",
              );

              if (choice === "open") {
                const url = `http://localhost:${running.port}`;
                openUrl(url);
                unlockStartup();
                process.exit(0);
              } else if (choice === "new") {
                // Defer config mutation until after config is loaded below
                startNewOrchestrator = true;
              } else if (choice === "restart") {
                try { process.kill(running.pid, "SIGTERM"); } catch { /* already dead */ }
                if (!(await waitForExit(running.pid, 5000))) {
                  console.log(chalk.yellow("  Process didn't exit cleanly, sending SIGKILL..."));
                  try { process.kill(running.pid, "SIGKILL"); } catch { /* already dead */ }
                  if (!(await waitForExit(running.pid, 3000))) {
                    throw new Error(
                      `Failed to stop AO process (PID ${running.pid}). Check permissions or stop it manually.`,
                    );
                  }
                }
                await unregister();
                console.log(chalk.yellow("\n  Stopped existing instance. Restarting...\n"));
                // Continue to startup below
              } else {
                unlockStartup();
                process.exit(0);
              }
            } else {
              // Agent/non-TTY caller — print info and exit
              console.log(`AO is already running.`);
              console.log(`Dashboard: http://localhost:${running.port}`);
              console.log(`PID: ${running.pid}`);
              console.log(`Projects: ${running.projects.join(", ")}`);
              console.log(`To restart: ao stop && ao start`);
              unlockStartup();
              process.exit(0);
            }
          }

          if (projectArg && isRepoUrl(projectArg)) {
            // ── URL argument: clone + auto-config + start ──
            console.log(chalk.bold.cyan("\n  Agent Orchestrator — Quick Start\n"));
            const result = await handleUrlStart(projectArg);
            config = result.config;
            ({ projectId, project } = await resolveProjectByRepo(config, result.parsed));
          } else if (projectArg && isLocalPath(projectArg)) {
            // ── Path argument: add project if new, then start ──
            const resolvedPath = resolve(projectArg.replace(/^~/, process.env["HOME"] || ""));

            // Try to load existing config
            let configPath: string | undefined;
            try {
              configPath = findConfigFile() ?? undefined;
            } catch {
              // No config found — create one first
            }

            if (!configPath) {
              if (resolve(cwd()) !== resolvedPath) {
                // Target path differs from cwd — create config at the target repo
                config = await autoCreateConfig(resolvedPath);
              } else {
                // cwd is the target — auto-create config here
                config = await autoCreateConfig(cwd());
              }
              ({ projectId, project } = await resolveProject(config));
            } else {
              config = loadConfig(configPath);

              // Check if project is already in config (match by path)
              const existingEntry = Object.entries(config.projects).find(
                ([, p]) => resolve(p.path.replace(/^~/, process.env["HOME"] || "")) === resolvedPath,
              );

              if (existingEntry) {
                // Already in config — just start it
                projectId = existingEntry[0];
                project = existingEntry[1];
              } else {
                // New project — add it to config
                const addedId = await addProjectToConfig(config, resolvedPath);
                config = loadConfig(config.configPath);
                projectId = addedId;
                project = config.projects[projectId];
              }
            }
          } else {
            // ── No arg or project ID: load config or auto-create ──
            let loadedConfig: OrchestratorConfig | null = null;
            try {
              loadedConfig = loadConfig();
            } catch (err) {
              if (err instanceof ConfigNotFoundError) {
                // First run — auto-create config
                loadedConfig = await autoCreateConfig(cwd());
              } else {
                throw err;
              }
            }
            config = loadedConfig;
            ({ projectId, project } = await resolveProject(config, projectArg));
          }

          // ── Handle "new orchestrator" choice (deferred from already-running check) ──
          if (startNewOrchestrator) {
            const rawYaml = readFileSync(config.configPath, "utf-8");
            const rawConfig = yamlParse(rawYaml);

            // Collect existing prefixes to avoid collisions
            const existingPrefixes = new Set(
              Object.values(rawConfig.projects as Record<string, Record<string, unknown>>).map(
                (p) => p.sessionPrefix as string,
              ).filter(Boolean),
            );

            let newId: string;
            let newPrefix: string;
            do {
              const suffix = Math.random().toString(36).slice(2, 6);
              newId = `${projectId}-${suffix}`;
              newPrefix = generateSessionPrefix(newId);
            } while (rawConfig.projects[newId] || existingPrefixes.has(newPrefix));

            rawConfig.projects[newId] = {
              ...rawConfig.projects[projectId],
              sessionPrefix: newPrefix,
            };
            writeFileSync(config.configPath, yamlStringify(rawConfig, { indent: 2 }));
            console.log(chalk.green(`\n✓ New orchestrator "${newId}" added to config\n`));
            config = loadConfig(config.configPath);
            projectId = newId;
            project = config.projects[newId];
          }

          // ── Agent selection prompt (Step 10)──
          const agentOverride = opts?.interactive ? await promptAgentSelection() : null;
          if (agentOverride) {
            const { orchestratorAgent, workerAgent } = agentOverride;

            if (isCanonicalGlobalConfigPath(config.configPath)) {
              const nextLocalConfig = readProjectBehaviorConfig(project.path);
              nextLocalConfig.orchestrator = {
                ...(nextLocalConfig.orchestrator ?? {}),
                agent: orchestratorAgent,
              };
              nextLocalConfig.worker = {
                ...(nextLocalConfig.worker ?? {}),
                agent: workerAgent,
              };
              writeProjectBehaviorConfig(project.path, nextLocalConfig);
              console.log(chalk.dim(`  ✓ Saved to ${project.path}/agent-orchestrator.yaml\n`));
            } else {
              const rawYaml = readFileSync(config.configPath, "utf-8");
              const rawConfig = yamlParse(rawYaml);
              const proj = rawConfig.projects[projectId];
              proj.orchestrator = { ...(proj.orchestrator ?? {}), agent: orchestratorAgent };
              proj.worker = { ...(proj.worker ?? {}), agent: workerAgent };
              writeFileSync(config.configPath, yamlStringify(rawConfig, { indent: 2 }));
              console.log(chalk.dim(`  ✓ Saved to ${config.configPath}\n`));
            }

            config = loadConfig(config.configPath);
            project = config.projects[projectId];
          }

          const actualPort = await runStartup(config, projectId, project, opts);

          // ── Register in running.json (Step 11) ──
          // Only record the project this invocation actually polls. Other
          // configured projects are not covered by this lifecycle loop, and
          // `ao spawn` relies on this list to decide whether to warn users.
          await register({
            pid: process.pid,
            configPath: config.configPath,
            port: actualPort,
            startedAt: new Date().toISOString(),
            projects: [projectId],
          });
          unlockStartup();

          // Install shutdown handlers so `ao stop` (which sends SIGTERM to
          // this pid) flushes lifecycle health state before exit. Handlers
          // MUST call process.exit() — installing a SIGINT/SIGTERM listener
          // removes Node's default exit behavior, so without an explicit
          // exit the interval timer would keep the event loop alive.
          let shuttingDown = false;
          const shutdown = (signal: NodeJS.Signals): void => {
            if (shuttingDown) return;
            shuttingDown = true;
            try {
              stopAllLifecycleWorkers();
            } catch {
              // Best-effort cleanup — never block shutdown on observability.
            }
            process.exit(signal === "SIGINT" ? 130 : 0);
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        } catch (err) {
          if (err instanceof Error) {
            console.error(chalk.red("\nError:"), err.message);
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          unlockStartup();
          process.exit(1);
        } finally {
          unlockStartup();
        }
      },
    );
}

/**
 * Check if arg looks like a local path (not a project ID).
 * Paths contain / or ~ or . at the start.
 */
function isLocalPath(arg: string): boolean {
  return arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("./") || arg.startsWith("..");
}

export function registerStop(program: Command): void {
  program
    .command("stop [project]")
    .description("Stop orchestrator agent and dashboard")
    .option("--purge-session", "Delete mapped OpenCode session when stopping")
    .option("--all", "Stop all running AO instances")
    .action(
      async (
        projectArg?: string,
        opts: { purgeSession?: boolean; all?: boolean } = {},
      ) => {
        try {
          // Check running.json first
          const running = await getRunning();

          if (opts.all) {
            // --all: kill via running.json if available, then fallback to config
            if (running) {
              try {
                process.kill(running.pid, "SIGTERM");
              } catch {
                // Already dead
              }
              await unregister();
              console.log(
                chalk.green(`\n✓ Stopped AO on port ${running.port}`),
              );
              console.log(chalk.dim(`  Projects: ${running.projects.join(", ")}\n`));
            } else {
              console.log(chalk.yellow("No running AO instance found in running.json."));
            }
            return;
          }

          const config = loadConfig();
          const { projectId: _projectId, project } = await resolveProject(config, projectArg, "stop");
          const port = config.port ?? DEFAULT_PORT;

          console.log(chalk.bold(`\nStopping orchestrator for ${chalk.cyan(project.name)}\n`));

          // Resolve the actual orchestrator session id by listing the project's sessions
          // and finding the most-recently-active orchestrator. This avoids relying on the
          // legacy `${prefix}-orchestrator` (no-N) phantom id, which never matches a real
          // numbered session and causes ao stop to silently no-op.
          const sm = await getSessionManager(config);
          const allSessionPrefixes = Object.entries(config.projects).map(
            ([, p]) => p.sessionPrefix ?? generateSessionPrefix(p.name ?? ""),
          );
          let orchestratorToKill: { id: string } | null = null;
          let lookupFailed = false;
          try {
            const projectSessions = await sm.list(_projectId);
            const orchestrators = projectSessions
              .filter((s) =>
                isOrchestratorSession(s, project.sessionPrefix ?? _projectId, allSessionPrefixes),
              )
              .filter((s) => !isTerminalSession(s));
            const sorted = [...orchestrators].sort(
              (a, b) =>
                (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0),
            );
            orchestratorToKill = sorted[0] ?? null;
          } catch (err) {
            lookupFailed = true;
            console.log(
              chalk.yellow(
                `  Could not list sessions to locate orchestrator: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
          }

          if (orchestratorToKill) {
            const spinner = ora("Stopping orchestrator session").start();
            const purgeOpenCode = opts?.purgeSession === true;
            await sm.kill(orchestratorToKill.id, { purgeOpenCode });
            spinner.succeed(`Orchestrator session stopped (${orchestratorToKill.id})`);
            // Also log to console.log so the killed id is visible in non-TTY callers
            // (CI, scripts) and in test capture, since spinner output is suppressed.
            console.log(chalk.green(`  Stopped orchestrator session: ${orchestratorToKill.id}`));
          } else if (!lookupFailed) {
            // Suppress the "no orchestrator found" message when sm.list threw —
            // the catch above already explained the real reason and adding a
            // second message would falsely imply the lookup succeeded.
            console.log(
              chalk.yellow(`No running orchestrator session found for "${project.name}"`),
            );
          }

          // Lifecycle polling runs in-process inside the `ao start` process
          // (registered via `running.json`). Sending SIGTERM to that PID below
          // triggers the shared shutdown handler in `lifecycle-service`, which
          // stops every per-project loop. No explicit stop call needed here —
          // this CLI invocation is a separate process with an empty active map.

          // Stop dashboard — kill parent PID from running.json, then also stop
          // any dashboard child process via lsof (parent SIGTERM may not propagate)
          if (running) {
            try {
              process.kill(running.pid, "SIGTERM");
            } catch {
              // Already dead
            }
            await unregister();
          }
          await stopDashboard(running?.port ?? port);

          console.log(chalk.bold.green("\n✓ Orchestrator stopped\n"));
          console.log(
            chalk.dim(`  Uptime: since ${running?.startedAt ?? "unknown"}`),
          );
          console.log(
            chalk.dim(`  Projects: ${Object.keys(config.projects).join(", ")}\n`),
          );
        } catch (err) {
          if (err instanceof Error) {
            console.error(chalk.red("\nError:"), err.message);
          } else {
            console.error(chalk.red("\nError:"), String(err));
          }
          process.exit(1);
        }
      });
}
