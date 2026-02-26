import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export type MergeStewardMethod = "squash" | "merge";

export interface MergeStewardOptions {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  testCommand: string;
  mergeMethod?: MergeStewardMethod;
  commitMessage?: string;
  autoPushAfterMerge?: boolean;
}

export interface MergeStewardExec {
  (command: string, args: string[], cwd?: string): Promise<void>;
}

export interface MergeStewardResult {
  merged: boolean;
  tempWorktreePath: string;
}

async function defaultExec(command: string, args: string[], cwd?: string): Promise<void> {
  await execFileAsync(command, args, { cwd, timeout: 120_000 });
}

export class MergeStewardService {
  constructor(private readonly exec: MergeStewardExec = defaultExec) {}

  async testThenMerge(options: MergeStewardOptions): Promise<MergeStewardResult> {
    const mergeMethod = options.mergeMethod ?? "squash";
    const autoPush = options.autoPushAfterMerge ?? true;
    const tempWorktreePath = await mkdtemp(join(tmpdir(), "ao-merge-steward-"));

    try {
      await this.exec("git", ["-C", options.repoPath, "fetch", "origin"]);
      await this.exec("git", [
        "-C",
        options.repoPath,
        "merge-tree",
        `origin/${options.targetBranch}`,
        options.sourceBranch,
      ]);

      await this.exec("git", [
        "-C",
        options.repoPath,
        "worktree",
        "add",
        "--detach",
        tempWorktreePath,
        `origin/${options.targetBranch}`,
      ]);

      await this.exec("sh", ["-lc", options.testCommand], tempWorktreePath);

      if (mergeMethod === "squash") {
        await this.exec("git", ["-C", tempWorktreePath, "merge", "--squash", options.sourceBranch]);
        await this.exec("git", [
          "-C",
          tempWorktreePath,
          "commit",
          "-m",
          options.commitMessage ?? `Merge ${options.sourceBranch} into ${options.targetBranch}`,
        ]);
      } else {
        await this.exec("git", [
          "-C",
          tempWorktreePath,
          "merge",
          "--no-ff",
          "-m",
          options.commitMessage ?? `Merge ${options.sourceBranch} into ${options.targetBranch}`,
          options.sourceBranch,
        ]);
      }

      if (autoPush) {
        await this.exec("git", [
          "-C",
          tempWorktreePath,
          "push",
          "origin",
          `HEAD:${options.targetBranch}`,
        ]);
      }

      return { merged: true, tempWorktreePath };
    } finally {
      await this.exec("git", ["-C", options.repoPath, "worktree", "remove", "--force", tempWorktreePath]);
    }
  }
}

