import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import { exec, gh } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";

interface ReviewInfo {
  sessionId: string;
  tmuxTarget: string;
  prNumber: string;
  pendingComments: number;
  reviewDecision: string | null;
}

async function checkPRReviews(
  repo: string,
  prNumber: string,
): Promise<{ pendingComments: number; reviewDecision: string | null }> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return { pendingComments: 0, reviewDecision: null };
  }

  // Use GraphQL with variable passing (-F) to avoid injection via repo names
  const query =
    "query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewDecision reviewThreads(first:100){nodes{isResolved}}}}}";
  const result = await gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `pr=${prNumber}`,
    "--jq",
    ".data.repository.pullRequest",
  ]);

  if (!result) {
    return { pendingComments: 0, reviewDecision: null };
  }

  try {
    const data = JSON.parse(result);
    const unresolvedCount = Array.isArray(data.reviewThreads?.nodes)
      ? data.reviewThreads.nodes.filter((t: { isResolved: boolean }) => !t.isResolved).length
      : 0;
    return {
      pendingComments: unresolvedCount,
      reviewDecision: data.reviewDecision || null,
    };
  } catch {
    return { pendingComments: 0, reviewDecision: null };
  }
}

export function registerReviewCheck(program: Command): void {
  program
    .command("review-check")
    .description("Check PRs for review comments and trigger agents to address them")
    .argument("[project]", "Project ID (checks all if omitted)")
    .option("--dry-run", "Show what would be done without sending messages")
    .action(async (projectId: string | undefined, opts: { dryRun?: boolean }) => {
      const config = loadConfig();

      if (projectId && !config.projects[projectId]) {
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const sessions = await sm.list(projectId);

      const spinner = ora("Checking PRs for review comments...").start();
      const results: ReviewInfo[] = [];

      for (const session of sessions) {
        const prUrl = session.metadata["pr"];
        if (!prUrl) continue;

        const project = config.projects[session.projectId];
        if (!project?.repo) continue;

        const prNum = prUrl.match(/(\d+)\s*$/)?.[1];
        if (!prNum) continue;

        try {
          const { pendingComments, reviewDecision } = await checkPRReviews(project.repo, prNum);
          if (pendingComments > 0 || reviewDecision === "CHANGES_REQUESTED") {
            results.push({
              sessionId: session.id,
              tmuxTarget: session.runtimeHandle?.id ?? session.id,
              prNumber: prNum,
              pendingComments,
              reviewDecision,
            });
          }
        } catch {
          // Skip PRs we can't access
        }
      }

      spinner.stop();

      if (results.length === 0) {
        console.log(chalk.green("No pending review comments found."));
        return;
      }

      console.log(
        chalk.bold(
          `\nFound ${results.length} session${results.length > 1 ? "s" : ""} with pending reviews:\n`,
        ),
      );

      for (const result of results) {
        console.log(`  ${chalk.green(result.sessionId)}  PR #${result.prNumber}`);
        if (result.reviewDecision) {
          console.log(`    Decision: ${chalk.yellow(result.reviewDecision)}`);
        }
        if (result.pendingComments > 0) {
          console.log(`    Comments: ${chalk.yellow(String(result.pendingComments))}`);
        }

        if (!opts.dryRun) {
          try {
            // Interrupt busy agent and clear partial input before sending
            await exec("tmux", ["send-keys", "-t", result.tmuxTarget, "C-c"]);
            await new Promise((resolve) => setTimeout(resolve, 500));
            await exec("tmux", ["send-keys", "-t", result.tmuxTarget, "C-u"]);
            await new Promise((resolve) => setTimeout(resolve, 200));
            const message =
              "There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.";
            await exec("tmux", ["send-keys", "-t", result.tmuxTarget, "-l", message]);
            await new Promise((resolve) => setTimeout(resolve, 200));
            await exec("tmux", ["send-keys", "-t", result.tmuxTarget, "Enter"]);
            console.log(chalk.green(`    -> Fix prompt sent`));
          } catch (err) {
            console.error(chalk.red(`    -> Failed to send: ${err}`));
          }
        } else {
          console.log(chalk.dim(`    (dry run — would send fix prompt)`));
        }
      }
      console.log();
    });
}
