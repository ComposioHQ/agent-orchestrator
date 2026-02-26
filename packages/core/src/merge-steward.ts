import { mkdtemp, rm } from "node:fs/promises";
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

function parseCommandArgs(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of command.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaped || quote) {
    throw new Error("Invalid test command: unterminated escape or quote");
  }
  if (current) parts.push(current);
  if (parts.length === 0) throw new Error("Invalid test command: empty");
  return parts;
}

export class MergeStewardService {
  constructor(private readonly exec: MergeStewardExec = defaultExec) {}

  async testThenMerge(options: MergeStewardOptions): Promise<MergeStewardResult> {
    const mergeMethod = options.mergeMethod ?? "squash";
    const autoPush = options.autoPushAfterMerge ?? true;
    const tempWorktreePath = await mkdtemp(join(tmpdir(), "ao-merge-steward-"));
    let testCmd = "";
    let testArgs: string[] = [];
    let worktreeAdded = false;
    let primaryError: unknown = null;

    try {
      [testCmd, ...testArgs] = parseCommandArgs(options.testCommand);

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
      worktreeAdded = true;

      await this.exec(testCmd, testArgs, tempWorktreePath);

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
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (worktreeAdded) {
        try {
          await this.exec("git", ["-C", options.repoPath, "worktree", "remove", "--force", tempWorktreePath]);
        } catch (cleanupError) {
          if (!primaryError) throw cleanupError;
        }
      }
      await rm(tempWorktreePath, { recursive: true, force: true });
    }
  }
}
