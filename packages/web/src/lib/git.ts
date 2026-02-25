/**
 * Git utility functions for the self-update feature.
 * Runs git commands against the agent-orchestrator repo.
 */

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { getServices } from "./services";

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

export async function getRepoDir(): Promise<string> {
  const { config } = await getServices();
  return dirname(config.configPath);
}

export interface PendingUpdate {
  behindCount: number;
  commits: Array<{ hash: string; subject: string }>;
  currentHead: string;
  remoteHead: string;
}

/** Fetch origin/main and check for pending updates. */
export async function checkForUpdates(): Promise<PendingUpdate | null> {
  const repoDir = await getRepoDir();

  // Fetch latest from remote
  await run(["fetch", "origin", "main"], repoDir);

  // Count commits behind
  const countStr = await run(["rev-list", "--count", "HEAD..origin/main"], repoDir);
  const behindCount = parseInt(countStr, 10);

  if (behindCount === 0) return null;

  // Get commit log
  const log = await run(
    ["log", "--format=%H %s", "HEAD..origin/main"],
    repoDir,
  );

  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      return {
        hash: line.slice(0, spaceIdx),
        subject: line.slice(spaceIdx + 1),
      };
    });

  const currentHead = await run(["rev-parse", "--short", "HEAD"], repoDir);
  const remoteHead = await run(["rev-parse", "--short", "origin/main"], repoDir);

  return { behindCount, commits, currentHead, remoteHead };
}

/** Check if there are uncommitted changes in the repo. */
export async function isDirty(): Promise<boolean> {
  const repoDir = await getRepoDir();
  const status = await run(["status", "--porcelain"], repoDir);
  return status.length > 0;
}
