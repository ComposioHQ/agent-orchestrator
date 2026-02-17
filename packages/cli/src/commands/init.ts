import { createInterface } from "node:readline/promises";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { cwd } from "node:process";
import { stringify as yamlStringify } from "yaml";
import chalk from "chalk";
import type { Command } from "commander";
import { git, gh, execSilent } from "../lib/shell.js";
import {
  detectProjectType,
  generateRulesFromTemplates,
  formatProjectTypeForDisplay,
} from "../lib/project-detection.js";

async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` ${chalk.dim(`(${defaultValue})`)}` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

interface EnvironmentInfo {
  isGitRepo: boolean;
  gitRemote: string | null;
  ownerRepo: string | null;
  currentBranch: string | null;
  defaultBranch: string | null;
  hasTmux: boolean;
  hasGh: boolean;
  ghAuthed: boolean;
  hasLinearKey: boolean;
  hasSlackWebhook: boolean;
}

async function detectDefaultBranch(
  workingDir: string,
  ownerRepo: string | null,
): Promise<string | null> {
  // Method 1: Try to get from git symbolic-ref (most reliable)
  const symbolicRef = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], workingDir);
  if (symbolicRef) {
    // Output: refs/remotes/origin/main
    const match = symbolicRef.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) {
      return match[1];
    }
  }

  // Method 2: Try GitHub API via gh CLI
  if (ownerRepo) {
    const ghResult = await gh([
      "repo",
      "view",
      ownerRepo,
      "--json",
      "defaultBranchRef",
      "-q",
      ".defaultBranchRef.name",
    ]);
    if (ghResult) {
      return ghResult;
    }
  }

  // Method 3: Check which common branch exists locally
  const commonBranches = ["main", "master", "next", "develop"];
  for (const branch of commonBranches) {
    const exists = await git(["rev-parse", "--verify", `origin/${branch}`], workingDir);
    if (exists) {
      return branch;
    }
  }

  // Fallback: return "main" as a reasonable default
  return "main";
}

async function detectEnvironment(workingDir: string): Promise<EnvironmentInfo> {
  // Check if in git repo
  const isGitRepo = (await git(["rev-parse", "--git-dir"], workingDir)) !== null;

  // Get git remote
  let gitRemote: string | null = null;
  let ownerRepo: string | null = null;
  if (isGitRepo) {
    gitRemote = await git(["remote", "get-url", "origin"], workingDir);
    if (gitRemote) {
      // Parse owner/repo from remote
      // Examples:
      //   git@github.com:owner/repo.git
      //   https://github.com/owner/repo.git
      const match = gitRemote.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
      if (match) {
        ownerRepo = match[1];
      }
    }
  }

  // Get current branch (for display only, NOT for defaultBranch)
  const currentBranch = isGitRepo ? await git(["branch", "--show-current"], workingDir) : null;

  // Detect the actual default branch (main/master/next)
  const defaultBranch = isGitRepo ? await detectDefaultBranch(workingDir, ownerRepo) : null;

  // Check for tmux (direct invocation more portable than 'which')
  const hasTmux = (await execSilent("tmux", ["-V"])) !== null;

  // Check for gh CLI (direct invocation more portable than 'which')
  const hasGh = (await execSilent("gh", ["--version"])) !== null;

  // Check gh auth status (rely on exit code, not output string)
  let ghAuthed = false;
  if (hasGh) {
    const authStatus = await gh(["auth", "status"]);
    // gh() returns null on error, non-null on success
    ghAuthed = authStatus !== null;
  }

  // Check for API keys in environment
  const hasLinearKey = !!process.env["LINEAR_API_KEY"];
  const hasSlackWebhook = !!process.env["SLACK_WEBHOOK_URL"];

  return {
    isGitRepo,
    gitRemote,
    ownerRepo,
    currentBranch,
    defaultBranch,
    hasTmux,
    hasGh,
    ghAuthed,
    hasLinearKey,
    hasSlackWebhook,
  };
}

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Interactive setup wizard — creates agent-orchestrator.yaml")
    .option("-o, --output <path>", "Output file path", "agent-orchestrator.yaml")
    .option("--auto", "Auto-generate config with sensible defaults (no prompts)")
    .option(
      "--smart",
      "Analyze project and generate custom rules (requires --auto, uses AI if available)",
    )
    .action(async (opts: { output: string; auto?: boolean; smart?: boolean }) => {
      const outputPath = resolve(opts.output);

      if (existsSync(outputPath)) {
        console.log(chalk.yellow(`Config already exists: ${outputPath}`));
        console.log("Delete it first or specify a different path with --output.");
        process.exit(1);
      }

      // Validate --smart requires --auto
      if (opts.smart && !opts.auto) {
        console.error(chalk.red("Error: --smart requires --auto"));
        console.log(chalk.dim("Use: ao init --auto --smart"));
        process.exit(1);
      }

      // Handle --auto mode
      if (opts.auto) {
        await handleAutoMode(outputPath, opts.smart || false);
        return;
      }

      console.log(chalk.bold.cyan("\n  Agent Orchestrator — Setup Wizard\n"));
      console.log(chalk.dim("  Detecting environment...\n"));

      const workingDir = cwd();
      const env = await detectEnvironment(workingDir);

      // Show detection results
      if (env.isGitRepo) {
        console.log(chalk.green("  ✓ Git repository detected"));
        if (env.ownerRepo) {
          console.log(chalk.dim(`    Remote: ${env.ownerRepo}`));
        }
        if (env.currentBranch) {
          console.log(chalk.dim(`    Branch: ${env.currentBranch}`));
        }
      } else {
        console.log(chalk.dim("  ○ Not in a git repository"));
      }

      if (env.hasTmux) {
        console.log(chalk.green("  ✓ tmux available"));
      } else {
        console.log(chalk.yellow("  ⚠ tmux not found"));
        console.log(chalk.dim("    Install with: brew install tmux"));
      }

      if (env.hasGh) {
        if (env.ghAuthed) {
          console.log(chalk.green("  ✓ GitHub CLI authenticated"));
        } else {
          console.log(chalk.yellow("  ⚠ GitHub CLI not authenticated"));
          console.log(chalk.dim("    Run: gh auth login"));
        }
      } else {
        console.log(chalk.yellow("  ⚠ GitHub CLI not found"));
        console.log(chalk.dim("    Install with: brew install gh"));
      }

      if (env.hasLinearKey) {
        console.log(chalk.green("  ✓ LINEAR_API_KEY detected"));
      }

      if (env.hasSlackWebhook) {
        console.log(chalk.green("  ✓ SLACK_WEBHOOK_URL detected"));
      }

      console.log();

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        // Basic config
        console.log(chalk.bold("  Configuration\n"));
        const dataDir = await prompt(
          rl,
          "Data directory (session metadata)",
          "~/.agent-orchestrator",
        );
        const worktreeDir = await prompt(rl, "Worktree directory", "~/.worktrees");
        const portStr = await prompt(rl, "Dashboard port", "3000");
        const port = parseInt(portStr, 10);
        if (isNaN(port) || port < 1 || port > 65535) {
          console.error(chalk.red("\nInvalid port number. Must be 1-65535."));
          rl.close();
          process.exit(1);
        }

        // Default plugins
        console.log(chalk.bold("\n  Default Plugins\n"));
        const runtime = await prompt(rl, "Runtime (tmux, process)", "tmux");
        const agent = await prompt(rl, "Agent (claude-code, codex, aider)", "claude-code");
        const workspace = await prompt(rl, "Workspace (worktree, clone)", "worktree");
        const notifiersStr = await prompt(
          rl,
          "Notifiers (comma-separated: desktop, slack)",
          "desktop",
        );
        const notifiers = notifiersStr.split(",").map((s) => s.trim());

        // First project
        console.log(chalk.bold("\n  First Project\n"));
        const defaultProjectId = env.isGitRepo ? basename(workingDir) : "";
        const projectId = await prompt(
          rl,
          "Project ID (short name, e.g. my-app)",
          defaultProjectId,
        );

        const config: Record<string, unknown> = {
          dataDir,
          worktreeDir,
          port,
          defaults: { runtime, agent, workspace, notifiers },
          projects: {} as Record<string, unknown>,
        };

        let projectPath = "";
        if (projectId) {
          const repo = await prompt(rl, "GitHub repo (owner/repo)", env.ownerRepo || "");
          projectPath = await prompt(
            rl,
            "Local path to repo",
            env.isGitRepo ? workingDir : `~/${projectId}`,
          );
          const defaultBranch = await prompt(rl, "Default branch", env.defaultBranch || "main");

          // Ask about tracker
          console.log(chalk.bold("\n  Issue Tracker\n"));
          if (env.hasLinearKey) {
            console.log(chalk.dim("  (LINEAR_API_KEY detected)\n"));
          }
          const tracker = await prompt(
            rl,
            "Tracker (github, linear, none)",
            env.hasLinearKey ? "linear" : "github",
          );

          const projectConfig: Record<string, unknown> = {
            repo,
            path: projectPath,
            defaultBranch,
          };

          if (tracker === "linear") {
            if (!env.hasLinearKey) {
              console.log(chalk.yellow("\nWarning: LINEAR_API_KEY not found in environment"));
              console.log(chalk.dim("Set it in your shell profile or .env file"));
              console.log(chalk.dim("Get your key at: https://linear.app/settings/api\n"));
            }

            const teamId = await prompt(rl, "Linear team ID (find at linear.app/settings/api)", "");
            if (teamId) {
              projectConfig.tracker = { plugin: "linear", teamId };
            }
          } else if (tracker === "none") {
            // Don't add tracker config
          } else {
            // Default to github (no explicit config needed)
          }

          (config.projects as Record<string, unknown>)[projectId] = projectConfig;
        }

        const yamlContent = yamlStringify(config, { indent: 2 });
        writeFileSync(outputPath, yamlContent);

        // Validation checks
        console.log(chalk.bold("\n  Validating Setup...\n"));

        const checks = [
          { name: "Git", pass: (await execSilent("git", ["--version"])) !== null },
          { name: "tmux", pass: env.hasTmux },
          { name: "GitHub CLI", pass: env.hasGh },
          ...(projectPath
            ? [
                {
                  name: "Repo path exists",
                  pass: existsSync(projectPath.replace(/^~/, process.env.HOME || "")),
                },
              ]
            : []),
        ];

        for (const { name, pass } of checks) {
          if (pass) {
            console.log(chalk.green(`  ✓ ${name}`));
          } else {
            console.log(chalk.yellow(`  ⚠ ${name} not found`));
          }
        }

        // Success message and next steps
        console.log(chalk.green(`\n✓ Config written to ${outputPath}\n`));
        console.log(chalk.bold("Next steps:\n"));
        console.log("  1. Review and edit the config:");
        console.log(chalk.cyan(`     nano ${outputPath}\n`));

        if (projectId) {
          console.log("  2. Spawn your first agent:");
          console.log(chalk.cyan(`     ao spawn ${projectId} ISSUE-123\n`));
        } else {
          console.log("  2. Add a project to the config:");
          console.log(chalk.cyan(`     nano ${outputPath}\n`));
        }

        console.log("  3. Monitor progress:");
        console.log(chalk.cyan("     ao status\n"));
        console.log("  4. Open dashboard:");
        console.log(chalk.cyan("     ao start\n"));
        console.log(chalk.dim("See SETUP.md for detailed configuration options.\n"));

        if (!env.hasTmux) {
          console.log(chalk.yellow("Note: tmux is required for the default runtime."));
          console.log(chalk.dim("Install with: brew install tmux\n"));
        }

        if (!env.ghAuthed && env.hasGh) {
          console.log(chalk.yellow("Note: Authenticate GitHub CLI for full functionality."));
          console.log(chalk.dim("Run: gh auth login\n"));
        }
      } finally {
        rl.close();
      }
    });
}

async function handleAutoMode(outputPath: string, smart: boolean): Promise<void> {
  const workingDir = cwd();

  console.log(chalk.bold.cyan("\n  Agent Orchestrator — Auto Setup\n"));

  if (smart) {
    console.log(chalk.dim("  🤖 Analyzing your project...\n"));
  } else {
    console.log(chalk.dim("  🚀 Auto-generating config with smart defaults...\n"));
  }

  // Detect environment
  const env = await detectEnvironment(workingDir);

  // Detect project type
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

  // Generate agent rules
  if (smart) {
    // TODO: Implement AI-powered rule generation in future PR
    console.log(chalk.yellow("  ⚠ AI-powered rule generation not yet implemented"));
    console.log(chalk.dim("  Using template-based rules for now...\n"));
  }

  const agentRules = generateRulesFromTemplates(projectType);

  // Build config with smart defaults
  const projectId = env.isGitRepo ? basename(workingDir) : "my-project";
  const repo = env.ownerRepo || "owner/repo";
  const hasPlaceholderRepo = repo === "owner/repo";
  const path = env.isGitRepo ? workingDir : `~/${projectId}`;
  const defaultBranch = env.defaultBranch || "main";

  const config: Record<string, unknown> = {
    dataDir: "~/.agent-orchestrator",
    worktreeDir: "~/.worktrees",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
      // Required for claude-code: each agent runs in a fresh git worktree it has
      // never seen before. Claude shows an interactive trust dialog on first entry
      // to any new directory. Without this flag the agent process blocks silently
      // waiting for keyboard input that never arrives, causing every spawned
      // session to hang at "spawning" indefinitely.
      agentConfig: {
        permissions: "skip",
      },
    },
    projects: {
      [projectId]: {
        repo,
        path,
        defaultBranch,
        agentRules,
      },
    },
  };

  // Write config
  const yamlContent = yamlStringify(config, { indent: 2 });
  writeFileSync(outputPath, yamlContent);

  // Show success message
  console.log(chalk.green(`✓ Config written to ${outputPath}\n`));

  // Warn if placeholder repo value is used
  if (hasPlaceholderRepo) {
    console.log(chalk.yellow("⚠ Warning: Could not detect GitHub repository"));
    console.log(chalk.dim("  Update the 'repo' field in the config before spawning agents\n"));
  }

  // Show generated rules
  if (agentRules) {
    console.log(chalk.bold("Generated agent rules:\n"));
    console.log(chalk.dim("---"));
    agentRules.split("\n").forEach((line) => {
      console.log(chalk.dim(`${line}`));
    });
    console.log(chalk.dim("---\n"));
  }

  // Show next steps
  console.log(chalk.bold("Next steps:\n"));

  if (hasPlaceholderRepo) {
    console.log("  1. Edit config and update 'repo' field:");
    console.log(chalk.cyan(`     nano ${outputPath}\n`));
    console.log("  2. Spawn your first agent:");
    console.log(chalk.cyan(`     ao spawn ${projectId} ISSUE-123\n`));
    console.log("  3. Monitor progress:");
    console.log(chalk.cyan("     ao status\n"));
  } else {
    console.log("  1. Review and customize (optional):");
    console.log(chalk.cyan(`     nano ${outputPath}\n`));
    console.log("  2. Spawn your first agent:");
    console.log(chalk.cyan(`     ao spawn ${projectId} ISSUE-123\n`));
    console.log("  3. Monitor progress:");
    console.log(chalk.cyan("     ao status\n"));
  }

  // Show warnings
  if (!env.hasTmux) {
    console.log(chalk.yellow("⚠ tmux not found - install with: brew install tmux"));
  }
  if (!env.ghAuthed && env.hasGh) {
    console.log(chalk.yellow("⚠ GitHub CLI not authenticated - run: gh auth login"));
  }

  console.log();
}
