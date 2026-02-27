/**
 * workspace-container-use plugin — git worktree inside a Docker container.
 *
 * Combines git worktree isolation with Docker container isolation.
 * Creates a worktree on the host first, then mounts it into a container.
 * Provides container-level isolation while preserving full git history.
 *
 * Uses execFile for both docker and git commands (never exec).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CMD_TIMEOUT = 30_000;
const DEFAULT_IMAGE = "ubuntu:22.04";
const CONTAINER_WORKSPACE_DIR = "/workspace";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Only allow safe characters in path segments to prevent directory traversal */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} "${value}": must match ${SAFE_PATH_SEGMENT}`);
  }
}

/** Expand ~ to home directory */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

/** Run a git command in a given directory */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: CMD_TIMEOUT,
  });
  return stdout.trimEnd();
}

/** Run a docker command */
async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    timeout: CMD_TIMEOUT,
  });
  return stdout.trimEnd();
}

/** Generate a deterministic container name from session/project IDs */
function containerName(projectId: string, sessionId: string): string {
  return `ao-${projectId}-${sessionId}`;
}

// ---------------------------------------------------------------------------
// Workspace implementation
// ---------------------------------------------------------------------------

export const manifest = {
  name: "container-use",
  slot: "workspace" as const,
  description: "Workspace plugin: git worktree inside Docker container",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Workspace {
  const worktreeBaseDir = config?.worktreeDir
    ? expandPath(config.worktreeDir as string)
    : join(homedir(), ".worktrees");

  const dockerImage = (config?.image as string) ?? DEFAULT_IMAGE;

  return {
    name: "container-use",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const projectWorktreeDir = join(worktreeBaseDir, cfg.projectId);
      const worktreePath = join(projectWorktreeDir, cfg.sessionId);

      mkdirSync(projectWorktreeDir, { recursive: true });

      // 1. Fetch latest from remote
      try {
        await git(repoPath, "fetch", "origin", "--quiet");
      } catch {
        // Fetch may fail if offline
      }

      const baseRef = `origin/${cfg.project.defaultBranch}`;

      // 2. Create git worktree on the host
      try {
        await git(repoPath, "worktree", "add", "-b", cfg.branch, worktreePath, baseRef);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          throw new Error(`Failed to create worktree for branch "${cfg.branch}": ${msg}`, {
            cause: err,
          });
        }
        // Branch already exists
        await git(repoPath, "worktree", "add", worktreePath, baseRef);
        try {
          await git(worktreePath, "checkout", cfg.branch);
        } catch (checkoutErr: unknown) {
          try {
            await git(repoPath, "worktree", "remove", "--force", worktreePath);
          } catch {
            // Best-effort cleanup
          }
          const checkoutMsg =
            checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
          throw new Error(
            `Failed to checkout branch "${cfg.branch}" in worktree: ${checkoutMsg}`,
            { cause: checkoutErr },
          );
        }
      }

      // 3. Start a Docker container with the worktree mounted
      const name = containerName(cfg.projectId, cfg.sessionId);

      try {
        await docker(
          "run",
          "-d",
          "--name",
          name,
          "-v",
          `${worktreePath}:${CONTAINER_WORKSPACE_DIR}`,
          "-w",
          CONTAINER_WORKSPACE_DIR,
          "--label",
          `ao.project=${cfg.projectId}`,
          "--label",
          `ao.session=${cfg.sessionId}`,
          dockerImage,
          "sleep",
          "infinity",
        );
      } catch (dockerErr: unknown) {
        // Docker failed — clean up the worktree
        try {
          await git(repoPath, "worktree", "remove", "--force", worktreePath);
        } catch {
          // Best-effort
        }
        const msg = dockerErr instanceof Error ? dockerErr.message : String(dockerErr);
        throw new Error(`Failed to start Docker container "${name}": ${msg}`, {
          cause: dockerErr,
        });
      }

      return {
        path: worktreePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      // Determine the container name from the path
      const sessionId = basename(workspacePath);
      const projectId = basename(resolve(workspacePath, ".."));
      const name = containerName(projectId, sessionId);

      // 1. Stop and remove the container
      try {
        await docker("rm", "-f", name);
      } catch {
        // Container may not exist
      }

      // 2. Remove the git worktree
      try {
        const gitCommonDir = await git(
          workspacePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        const repoPath = resolve(gitCommonDir, "..");
        await git(repoPath, "worktree", "remove", "--force", workspacePath);
      } catch {
        // Fallback: remove directory
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectWorktreeDir = join(worktreeBaseDir, projectId);
      if (!existsSync(projectWorktreeDir)) return [];

      const entries = readdirSync(projectWorktreeDir, { withFileTypes: true });
      const infos: WorkspaceInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const worktreePath = join(projectWorktreeDir, entry.name);
        let branch: string;

        try {
          branch = await git(worktreePath, "branch", "--show-current");
        } catch {
          continue;
        }

        infos.push({
          path: worktreePath,
          branch,
          sessionId: entry.name,
          projectId,
        });
      }

      return infos;
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
      // Run postCreate hooks inside the container
      if (project.postCreate) {
        const name = containerName(info.projectId, info.sessionId);
        for (const command of project.postCreate) {
          await execFileAsync("docker", ["exec", name, "sh", "-c", command], {
            timeout: CMD_TIMEOUT,
          });
        }
      }
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;

      // Check that the worktree exists on disk
      try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: workspacePath,
          timeout: CMD_TIMEOUT,
        });
      } catch {
        return false;
      }

      // Also check that the container is running
      const sessionId = basename(workspacePath);
      const projectId = basename(resolve(workspacePath, ".."));
      const name = containerName(projectId, sessionId);

      try {
        const result = await docker("inspect", "-f", "{{.State.Running}}", name);
        return result.trim() === "true";
      } catch {
        return false;
      }
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const workspaceParentDir = resolve(workspacePath, "..");

      mkdirSync(workspaceParentDir, { recursive: true });

      if (existsSync(workspacePath)) {
        throw new Error(
          `Workspace path "${workspacePath}" already exists for session "${cfg.sessionId}" — destroy it before restoring`,
        );
      }

      // Prune stale worktree entries
      try {
        await git(repoPath, "worktree", "prune");
      } catch {
        // Best effort
      }

      // Fetch latest
      try {
        await git(repoPath, "fetch", "origin", "--quiet");
      } catch {
        // May fail if offline
      }

      // Create worktree on existing branch
      try {
        await git(repoPath, "worktree", "add", workspacePath, cfg.branch);
      } catch {
        const remoteBranch = `origin/${cfg.branch}`;
        try {
          await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, remoteBranch);
        } catch {
          const baseRef = `origin/${cfg.project.defaultBranch}`;
          await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, baseRef);
        }
      }

      // Start a new container
      const name = containerName(cfg.projectId, cfg.sessionId);

      // Remove any existing container
      try {
        await docker("rm", "-f", name);
      } catch {
        // May not exist
      }

      try {
        await docker(
          "run",
          "-d",
          "--name",
          name,
          "-v",
          `${workspacePath}:${CONTAINER_WORKSPACE_DIR}`,
          "-w",
          CONTAINER_WORKSPACE_DIR,
          "--label",
          `ao.project=${cfg.projectId}`,
          "--label",
          `ao.session=${cfg.sessionId}`,
          dockerImage,
          "sleep",
          "infinity",
        );
      } catch (dockerErr: unknown) {
        try {
          await docker("rm", "-f", name);
        } catch {
          // Best-effort cleanup
        }
        try {
          await git(repoPath, "worktree", "remove", "--force", workspacePath);
        } catch {
          // Best-effort cleanup
        }
        const msg = dockerErr instanceof Error ? dockerErr.message : String(dockerErr);
        throw new Error(`Failed to start Docker container "${name}" during restore: ${msg}`, {
          cause: dockerErr,
        });
      }

      return {
        path: workspacePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
