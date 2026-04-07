/**
 * Rebase Coordinator — cross-session file conflict detection and auto-rebase.
 *
 * When a session's PR merges, sibling sessions touching overlapping files are
 * automatically rebased on origin/<defaultBranch>. Clean rebases are pushed
 * with --force-with-lease; conflicts are aborted and the diff is delivered to
 * the sibling agent via inbox.
 */

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Session, SessionId } from "./types.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
const WORKING_FILES_PATH = ".ao/working-files.jsonl";
const MAX_DIFF_BYTES = 4000;

export interface RebaseResult {
  sessionId: SessionId;
  outcome: "clean" | "dirty_skip" | "conflict" | "error";
  message: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function readWorkingFiles(workspacePath: string): Promise<Set<string>> {
  const filePath = join(workspacePath, WORKING_FILES_PATH);
  const result = new Set<string>();

  try {
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    await new Promise<void>((resolve) => {
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const file = parsed["file"];
          if (typeof file === "string" && file) result.add(file);
        } catch {
          // Skip malformed lines.
        }
      });
      rl.on("close", resolve);
      rl.on("error", resolve);
      stream.on("error", resolve);
    });
  } catch {
    // File missing or unreadable — return empty set.
  }

  return result;
}

function hasOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const file of a) {
    if (b.has(file)) return true;
  }
  return false;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function rebaseSibling(
  sibling: Session,
  mergedSession: Session,
  mergedFiles: Set<string>,
  defaultBranch: string,
  sendMessage: (sessionId: SessionId, message: string) => Promise<void>,
): Promise<RebaseResult | null> {
  const cwd = sibling.workspacePath;
  const branch = sibling.branch;
  if (!cwd || !branch) return null;

  const siblingFiles = await readWorkingFiles(cwd);
  if (!hasOverlap(mergedFiles, siblingFiles)) return null;

  const status = await runGit(["status", "--porcelain"], cwd);
  if (status.exitCode !== 0) {
    return {
      sessionId: sibling.id,
      outcome: "error",
      message: `git status failed: ${status.stderr.trim()}`,
    };
  }

  if (status.stdout.trim().length > 0) {
    const msg =
      `Session ${mergedSession.id} merged changes that overlap your working files. ` +
      `Auto-rebase skipped because your worktree has uncommitted changes. ` +
      `Run: git fetch origin && git rebase origin/${defaultBranch}`;
    await safeSend(sendMessage, sibling.id, msg);
    return { sessionId: sibling.id, outcome: "dirty_skip", message: msg };
  }

  const fetch = await runGit(["fetch", "origin"], cwd);
  if (fetch.exitCode !== 0) {
    return {
      sessionId: sibling.id,
      outcome: "error",
      message: `git fetch failed: ${fetch.stderr.trim()}`,
    };
  }

  const rebase = await runGit(["rebase", `origin/${defaultBranch}`], cwd);
  if (rebase.exitCode === 0) {
    const push = await runGit(["push", "--force-with-lease", "origin", branch], cwd);
    const note =
      push.exitCode === 0
        ? "Your branch has been pushed."
        : `Push failed (${push.stderr.trim()}). Push manually.`;
    const msg = `Auto-rebased on origin/${defaultBranch} after ${mergedSession.id} merged. ${note}`;
    await safeSend(sendMessage, sibling.id, msg);
    return { sessionId: sibling.id, outcome: "clean", message: msg };
  }

  await runGit(["rebase", "--abort"], cwd);

  const conflictingFiles = [...siblingFiles].filter((f) => mergedFiles.has(f));
  const diff = await runGit(
    ["diff", `HEAD..origin/${defaultBranch}`, "--", ...conflictingFiles],
    cwd,
  );
  const diffBody = diff.stdout.trim();

  const detail = diffBody
    ? `\`\`\`diff\n${diffBody.slice(0, MAX_DIFF_BYTES)}\n\`\`\``
    : `Conflicting files: ${conflictingFiles.join(", ")}`;
  const msg =
    `Session ${mergedSession.id} merged conflicting changes. Auto-rebase aborted. ` +
    `Run: git fetch origin && git rebase origin/${defaultBranch}\n\n${detail}`;
  await safeSend(sendMessage, sibling.id, msg);
  return { sessionId: sibling.id, outcome: "conflict", message: msg };
}

async function safeSend(
  sendMessage: (sessionId: SessionId, message: string) => Promise<void>,
  sessionId: SessionId,
  message: string,
): Promise<void> {
  try {
    await sendMessage(sessionId, message);
  } catch {
    // Best-effort delivery.
  }
}

export async function triggerRebaseForSiblings(
  mergedSession: Session,
  activeSiblings: Session[],
  defaultBranch: string,
  sendMessage: (sessionId: SessionId, message: string) => Promise<void>,
): Promise<RebaseResult[]> {
  if (!mergedSession.workspacePath) return [];

  const mergedFiles = await readWorkingFiles(mergedSession.workspacePath);
  if (mergedFiles.size === 0) return [];

  const results: RebaseResult[] = [];
  for (const sibling of activeSiblings) {
    try {
      const result = await rebaseSibling(
        sibling,
        mergedSession,
        mergedFiles,
        defaultBranch,
        sendMessage,
      );
      if (result) results.push(result);
    } catch (err) {
      results.push({
        sessionId: sibling.id,
        outcome: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
