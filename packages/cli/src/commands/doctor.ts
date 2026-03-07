import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { execSilent, git } from "../lib/shell.js";
import { findConfigFile, loadConfig } from "@composio/ao-core";

const MIN_NODE_MAJOR = 20;

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
}

function pass(name: string, message: string): CheckResult {
  return { name, status: "pass", message };
}

function warn(name: string, message: string, fix?: string): CheckResult {
  return { name, status: "warn", message, fix };
}

function fail(name: string, message: string, fix?: string): CheckResult {
  return { name, status: "fail", message, fix };
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

function isDirectoryWritable(dirPath: string): boolean {
  if (existsSync(dirPath)) {
    try {
      accessSync(dirPath, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  // If it doesn't exist, check the parent directory
  const parent = resolve(dirPath, "..");
  if (existsSync(parent)) {
    try {
      accessSync(parent, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const [major] = process.versions.node.split(".").map(Number);
  if (major >= MIN_NODE_MAJOR) {
    return pass("Node.js", `v${process.versions.node} (>= ${MIN_NODE_MAJOR} required)`);
  }
  return fail(
    "Node.js",
    `v${process.versions.node} — requires Node ${MIN_NODE_MAJOR}+`,
    `Install Node.js ${MIN_NODE_MAJOR}+ via: nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`,
  );
}

async function checkGit(): Promise<CheckResult> {
  const output = await execSilent("git", ["--version"]);
  if (!output) {
    return fail("Git", "not found", "Install git: https://git-scm.com/downloads");
  }
  return pass("Git", output.replace("git version ", ""));
}

async function checkGitRepo(): Promise<CheckResult> {
  const result = await git(["rev-parse", "--git-dir"]);
  if (!result) {
    return warn("Git repo", "not in a git repository — ao works best inside a git repo");
  }
  return pass("Git repo", "current directory is a git repository");
}

async function checkTmux(): Promise<CheckResult> {
  const output = await execSilent("tmux", ["-V"]);
  if (!output) {
    return fail(
      "tmux",
      "not found (required for default tmux runtime)",
      "Install with: brew install tmux  (or apt install tmux)",
    );
  }
  return pass("tmux", output.trim());
}

async function checkGhCli(): Promise<CheckResult[]> {
  const version = await execSilent("gh", ["--version"]);
  if (!version) {
    return [
      warn(
        "GitHub CLI",
        "not found — required for GitHub tracker and SCM features",
        "Install with: brew install gh",
      ),
    ];
  }

  const versionLine = version.split("\n")[0] ?? "gh";
  const authOutput = await execSilent("gh", ["auth", "status"]);
  if (authOutput === null) {
    return [
      pass("GitHub CLI", versionLine),
      warn("GitHub CLI auth", "not authenticated", "Run: gh auth login"),
    ];
  }
  return [
    pass("GitHub CLI", versionLine),
    pass("GitHub CLI auth", "authenticated"),
  ];
}

async function checkAgentCli(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const claudeVersion = await execSilent("claude", ["--version"]);
  if (claudeVersion) {
    results.push(pass("claude-code", claudeVersion.split("\n")[0] ?? "installed"));
  } else {
    results.push(
      warn(
        "claude-code",
        "not found — required if using the claude-code agent plugin",
        "Install with: npm install -g @anthropic-ai/claude-code",
      ),
    );
  }

  const codexVersion = await execSilent("codex", ["--version"]);
  if (codexVersion) {
    results.push(pass("codex", codexVersion.split("\n")[0] ?? "installed"));
  }

  const aiderVersion = await execSilent("aider", ["--version"]);
  if (aiderVersion) {
    results.push(pass("aider", aiderVersion.split("\n")[0] ?? "installed"));
  }

  // At least one agent must be present
  const hasAnyAgent = claudeVersion || codexVersion || aiderVersion;
  if (!hasAnyAgent) {
    // Already warned about claude-code above; no need to add another entry
  }

  return results;
}

async function checkConfig(): Promise<CheckResult[]> {
  const configPath = findConfigFile();
  if (!configPath) {
    return [
      warn(
        "Config file",
        "agent-orchestrator.yaml not found in current directory or parent directories",
        "Run: ao init",
      ),
    ];
  }

  const results: CheckResult[] = [pass("Config file", configPath)];

  try {
    loadConfig(configPath);
    results.push(pass("Config validation", "valid"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push(fail("Config validation", message, `Fix the errors in ${configPath}`));
  }

  return results;
}

async function checkDirectories(_configPath: string | null): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const dataDir = "~/.agent-orchestrator";
  const worktreeDir = "~/.worktrees";

  const expandedDataDir = expandPath(dataDir);
  const expandedWorktreeDir = expandPath(worktreeDir);

  if (isDirectoryWritable(expandedDataDir)) {
    results.push(
      pass("dataDir", `${dataDir} — ${existsSync(expandedDataDir) ? "exists and writable" : "parent writable, will be created"}`),
    );
  } else {
    results.push(
      fail(
        "dataDir",
        `${dataDir} — not writable`,
        `Run: mkdir -p ${expandedDataDir} && chmod 755 ${expandedDataDir}`,
      ),
    );
  }

  if (isDirectoryWritable(expandedWorktreeDir)) {
    results.push(
      pass("worktreeDir", `${worktreeDir} — ${existsSync(expandedWorktreeDir) ? "exists and writable" : "parent writable, will be created"}`),
    );
  } else {
    results.push(
      fail(
        "worktreeDir",
        `${worktreeDir} — not writable`,
        `Run: mkdir -p ${expandedWorktreeDir} && chmod 755 ${expandedWorktreeDir}`,
      ),
    );
  }

  return results;
}

async function checkOptionalIntegrations(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  if (process.env["LINEAR_API_KEY"]) {
    results.push(pass("LINEAR_API_KEY", "set"));
  } else {
    results.push(
      warn(
        "LINEAR_API_KEY",
        "not set — required for Linear tracker",
        "Set in your shell profile: export LINEAR_API_KEY=lin_api_...",
      ),
    );
  }

  if (process.env["SLACK_WEBHOOK_URL"]) {
    results.push(pass("SLACK_WEBHOOK_URL", "set"));
  }

  return results;
}

function printCheck(check: CheckResult): void {
  const icon =
    check.status === "pass" ? chalk.green("✓") :
    check.status === "warn" ? chalk.yellow("⚠") :
    chalk.red("✗");

  const nameCol = chalk.bold(check.name.padEnd(22));
  const messageColor =
    check.status === "pass" ? chalk.dim :
    check.status === "warn" ? chalk.yellow :
    chalk.red;

  console.log(`  ${icon} ${nameCol} ${messageColor(check.message)}`);
  if (check.fix && check.status !== "pass") {
    console.log(`    ${chalk.dim("→")} ${chalk.cyan(check.fix)}`);
  }
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check system health — verify prerequisites and configuration")
    .action(async () => {
      console.log(chalk.bold.cyan("\n  ao doctor — System Health Check\n"));

      const allChecks: CheckResult[] = [];

      // --- Core prerequisites ---
      console.log(chalk.bold("  Core prerequisites"));
      const nodeCheck = await checkNodeVersion();
      allChecks.push(nodeCheck);
      printCheck(nodeCheck);

      const gitCheck = await checkGit();
      allChecks.push(gitCheck);
      printCheck(gitCheck);

      const gitRepoCheck = await checkGitRepo();
      allChecks.push(gitRepoCheck);
      printCheck(gitRepoCheck);

      const tmuxCheck = await checkTmux();
      allChecks.push(tmuxCheck);
      printCheck(tmuxCheck);

      // --- GitHub CLI ---
      console.log(chalk.bold("\n  GitHub CLI"));
      const ghChecks = await checkGhCli();
      allChecks.push(...ghChecks);
      ghChecks.forEach(printCheck);

      // --- Agent CLIs ---
      console.log(chalk.bold("\n  Agent CLIs"));
      const agentChecks = await checkAgentCli();
      allChecks.push(...agentChecks);
      agentChecks.forEach(printCheck);

      // --- Configuration ---
      console.log(chalk.bold("\n  Configuration"));
      const configChecks = await checkConfig();
      allChecks.push(...configChecks);
      configChecks.forEach(printCheck);

      // --- Directories ---
      const configPath = findConfigFile();
      console.log(chalk.bold("\n  Directories"));
      const dirChecks = await checkDirectories(configPath);
      allChecks.push(...dirChecks);
      dirChecks.forEach(printCheck);

      // --- Optional integrations ---
      console.log(chalk.bold("\n  Optional integrations"));
      const optionalChecks = await checkOptionalIntegrations();
      allChecks.push(...optionalChecks);
      optionalChecks.forEach(printCheck);

      // --- Summary ---
      const failures = allChecks.filter((c) => c.status === "fail");
      const warnings = allChecks.filter((c) => c.status === "warn");
      const passes = allChecks.filter((c) => c.status === "pass");

      console.log();
      if (failures.length === 0 && warnings.length === 0) {
        console.log(chalk.green.bold(`  ✓ All ${passes.length} checks passed — you're good to go!`));
      } else if (failures.length === 0) {
        console.log(
          chalk.yellow.bold(
            `  ⚠ ${passes.length} passed, ${warnings.length} warning${warnings.length !== 1 ? "s" : ""} — optional features may be unavailable`,
          ),
        );
      } else {
        console.log(
          chalk.red.bold(
            `  ✗ ${failures.length} critical issue${failures.length !== 1 ? "s" : ""} found (${warnings.length} warning${warnings.length !== 1 ? "s" : ""}, ${passes.length} passed)`,
          ),
        );
        console.log(chalk.dim("\n  Fix the critical issues above before running ao start\n"));
      }

      console.log();

      // Exit with non-zero code if there are critical failures
      if (failures.length > 0) {
        process.exit(1);
      }
    });
}
