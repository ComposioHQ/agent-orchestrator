import chalk from "chalk";
import { existsSync, accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import { execSilent, git, gh } from "../lib/shell.js";

// =============================================================================
// Check Definitions
// =============================================================================

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail?: string;
  fix?: string;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 20) {
    return { name: "Node.js", status: "pass", detail: `v${process.versions.node}` };
  }
  return {
    name: "Node.js",
    status: "fail",
    detail: `v${process.versions.node} (requires >= 20)`,
    fix: "Install Node.js 20+ from https://nodejs.org",
  };
}

async function checkGit(): Promise<CheckResult> {
  const version = await execSilent("git", ["--version"]);
  if (version) {
    const v = version.replace("git version ", "").trim();
    return { name: "Git", status: "pass", detail: v };
  }
  return {
    name: "Git",
    status: "fail",
    detail: "not found",
    fix: "Install git: brew install git",
  };
}

async function checkGitConfig(): Promise<CheckResult> {
  const name = await git(["config", "user.name"]);
  const email = await git(["config", "user.email"]);
  if (name && email) {
    return { name: "Git config", status: "pass", detail: `${name} <${email}>` };
  }
  const missing = [!name && "user.name", !email && "user.email"].filter(Boolean).join(", ");
  return {
    name: "Git config",
    status: "warn",
    detail: `missing: ${missing}`,
    fix: "Run: git config --global user.name 'Your Name' && git config --global user.email 'you@example.com'",
  };
}

async function checkTmux(): Promise<CheckResult> {
  const version = await execSilent("tmux", ["-V"]);
  if (version) {
    return { name: "tmux", status: "pass", detail: version.trim() };
  }
  return {
    name: "tmux",
    status: "fail",
    detail: "not found",
    fix: "Install tmux: brew install tmux",
  };
}

async function checkGhCli(): Promise<CheckResult> {
  const version = await execSilent("gh", ["--version"]);
  if (!version) {
    return {
      name: "GitHub CLI",
      status: "warn",
      detail: "not found",
      fix: "Install: brew install gh",
    };
  }
  const v = version.split("\n")[0]?.trim() ?? version.trim();
  const authStatus = await gh(["auth", "status"]);
  if (authStatus !== null) {
    return { name: "GitHub CLI", status: "pass", detail: `${v}, authenticated` };
  }
  return {
    name: "GitHub CLI",
    status: "warn",
    detail: `${v}, not authenticated`,
    fix: "Run: gh auth login",
  };
}

async function checkAgentCli(name: string, binary: string): Promise<CheckResult> {
  const version = await execSilent(binary, ["--version"]);
  if (version) {
    const v = version.split("\n")[0]?.trim() ?? version.trim();
    return { name: `Agent: ${name}`, status: "pass", detail: v };
  }
  return {
    name: `Agent: ${name}`,
    status: "warn",
    detail: "not found",
    fix: `Install ${name} CLI to use it as an agent`,
  };
}

function checkConfigFile(): CheckResult {
  // Try common config file names
  const names = ["agent-orchestrator.yaml", "agent-orchestrator.yml", "ao.yaml", "ao.yml"];
  for (const name of names) {
    const fullPath = resolve(name);
    if (existsSync(fullPath)) {
      return { name: "Config file", status: "pass", detail: name };
    }
  }
  return {
    name: "Config file",
    status: "warn",
    detail: "not found in current directory",
    fix: "Run: ao init",
  };
}

async function checkConfigValid(): Promise<CheckResult> {
  try {
    const config = await loadConfig();
    const projectCount = Object.keys(config.projects).length;
    if (projectCount === 0) {
      return {
        name: "Config validation",
        status: "warn",
        detail: "no projects defined",
        fix: "Add at least one project to your config file",
      };
    }
    return {
      name: "Config validation",
      status: "pass",
      detail: `${projectCount} project${projectCount === 1 ? "" : "s"} configured`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "Config validation",
      status: "fail",
      detail: msg.length > 80 ? msg.slice(0, 80) + "..." : msg,
      fix: "Fix config errors or run: ao init",
    };
  }
}

function checkDataDir(): CheckResult {
  const dataDir = resolve(
    (process.env["AO_DATA_DIR"] ?? "~/.agent-orchestrator").replace(
      /^~/,
      process.env["HOME"] ?? "",
    ),
  );

  if (!existsSync(dataDir)) {
    return {
      name: "Data directory",
      status: "warn",
      detail: `${dataDir} does not exist (will be created on first spawn)`,
    };
  }

  try {
    accessSync(dataDir, constants.W_OK);
    return { name: "Data directory", status: "pass", detail: dataDir };
  } catch {
    return {
      name: "Data directory",
      status: "fail",
      detail: `${dataDir} is not writable`,
      fix: `Fix permissions: chmod u+w ${dataDir}`,
    };
  }
}

// =============================================================================
// Command Registration
// =============================================================================

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check system health — verify prerequisites and configuration")
    .option("--agents", "Also check for agent CLI binaries")
    .action(async (opts: { agents?: boolean }) => {
      console.log(chalk.bold.cyan("\n  Agent Orchestrator — Doctor\n"));
      console.log(chalk.dim("  Checking system health...\n"));

      const checks: CheckResult[] = [];

      // Core prerequisites
      checks.push(await checkNodeVersion());
      checks.push(await checkGit());
      checks.push(await checkGitConfig());
      checks.push(await checkTmux());
      checks.push(await checkGhCli());

      // Agent CLIs (optional, shown with --agents)
      if (opts.agents) {
        checks.push(await checkAgentCli("claude-code", "claude"));
        checks.push(await checkAgentCli("codex", "codex"));
        checks.push(await checkAgentCli("aider", "aider"));
        checks.push(await checkAgentCli("opencode", "opencode"));
      }

      // Configuration
      checks.push(checkConfigFile());
      checks.push(await checkConfigValid());
      checks.push(checkDataDir());

      // Display results
      let passCount = 0;
      let warnCount = 0;
      let failCount = 0;

      for (const check of checks) {
        const detail = check.detail ? chalk.dim(` — ${check.detail}`) : "";
        switch (check.status) {
          case "pass":
            console.log(chalk.green(`  ✓ ${check.name}`) + detail);
            passCount++;
            break;
          case "warn":
            console.log(chalk.yellow(`  ⚠ ${check.name}`) + detail);
            if (check.fix) {
              console.log(chalk.dim(`    → ${check.fix}`));
            }
            warnCount++;
            break;
          case "fail":
            console.log(chalk.red(`  ✗ ${check.name}`) + detail);
            if (check.fix) {
              console.log(chalk.dim(`    → ${check.fix}`));
            }
            failCount++;
            break;
        }
      }

      // Summary
      console.log();
      const parts: string[] = [];
      if (passCount > 0) parts.push(chalk.green(`${passCount} passed`));
      if (warnCount > 0) parts.push(chalk.yellow(`${warnCount} warnings`));
      if (failCount > 0) parts.push(chalk.red(`${failCount} failed`));
      console.log(`  ${parts.join(", ")}\n`);

      if (failCount > 0) {
        console.log(
          chalk.red("  Some critical checks failed. Fix them before using Agent Orchestrator.\n"),
        );
        process.exit(1);
      } else if (warnCount > 0) {
        console.log(chalk.yellow("  Some optional checks have warnings. AO should still work.\n"));
      } else {
        console.log(chalk.green("  All checks passed! Your setup looks good.\n"));
      }
    });
}
