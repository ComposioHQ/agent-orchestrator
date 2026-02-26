import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

/** Timeout for git commands (30 seconds) */
const GIT_TIMEOUT = 30_000;

/** Timeout for devcontainer up (5 minutes) */
const DEVCONTAINER_TIMEOUT = 300_000;

export const manifest = {
  name: "devcontainer",
  slot: "workspace" as const,
  description: "Workspace plugin: Dev Containers (worktree + devcontainer)",
  version: "0.1.0",
};

/** Run a git command in a given directory */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT,
  });
  return stdout.trimEnd();
}

/** Only allow safe characters in path segments to prevent directory traversal */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(
      `Invalid ${label} "${value}": must match ${SAFE_PATH_SEGMENT}`,
    );
  }
}

/** Expand ~ to home directory */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function create(config?: Record<string, unknown>): Workspace {
  const worktreeBaseDir = config?.worktreeDir
    ? expandPath(config.worktreeDir as string)
    : join(homedir(), ".worktrees");

  return {
    name: "devcontainer",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const projectWorktreeDir = join(worktreeBaseDir, cfg.projectId);
      const worktreePath = join(projectWorktreeDir, cfg.sessionId);

      mkdirSync(projectWorktreeDir, { recursive: true });

      // Fetch latest from remote
      try {
        await git(repoPath, "fetch", "origin", "--quiet");
      } catch {
        // Fetch may fail if offline -- continue anyway
      }

      const baseRef = `origin/${cfg.project.defaultBranch}`;

      // Create worktree with a new branch
      try {
        await git(
          repoPath,
          "worktree",
          "add",
          "-b",
          cfg.branch,
          worktreePath,
          baseRef,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          throw new Error(
            `Failed to create worktree for branch "${cfg.branch}": ${msg}`,
            { cause: err },
          );
        }
        // Branch already exists -- create worktree and check it out
        await git(repoPath, "worktree", "add", worktreePath, baseRef);
        await git(worktreePath, "checkout", cfg.branch);
      }

      // Start the devcontainer
      await execFileAsync(
        "devcontainer",
        ["up", "--workspace-folder", worktreePath],
        { timeout: DEVCONTAINER_TIMEOUT },
      );

      return {
        path: worktreePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      // Shut down the devcontainer first
      try {
        await execFileAsync(
          "devcontainer",
          ["down", "--workspace-folder", workspacePath],
          { timeout: GIT_TIMEOUT },
        );
      } catch {
        // devcontainer down may fail if already stopped
      }

      // Remove the worktree
      try {
        const gitCommonDir = await git(
          workspacePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        const repoPath = join(gitCommonDir, "..");
        await git(repoPath, "worktree", "remove", "--force", workspacePath);
      } catch {
        // If git commands fail, try to clean up the directory
        if (existsSync(workspacePath)) {
          const { rmSync } = await import("node:fs");
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
        const wPath = join(projectWorktreeDir, entry.name);
        let branch: string;
        try {
          branch = await git(wPath, "branch", "--show-current");
        } catch {
          continue;
        }
        infos.push({
          path: wPath,
          branch,
          sessionId: entry.name,
          projectId,
        });
      }

      return infos;
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;
      try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: workspacePath,
          timeout: GIT_TIMEOUT,
        });
        return true;
      } catch {
        return false;
      }
    },

    async restore(
      cfg: WorkspaceCreateConfig,
      workspacePath: string,
    ): Promise<WorkspaceInfo> {
      const repoPath = expandPath(cfg.project.path);

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

      // Try to create worktree on the existing branch
      try {
        await git(repoPath, "worktree", "add", workspacePath, cfg.branch);
      } catch {
        const remoteBranch = `origin/${cfg.branch}`;
        try {
          await git(
            repoPath,
            "worktree",
            "add",
            "-b",
            cfg.branch,
            workspacePath,
            remoteBranch,
          );
        } catch {
          const baseRef = `origin/${cfg.project.defaultBranch}`;
          await git(
            repoPath,
            "worktree",
            "add",
            "-b",
            cfg.branch,
            workspacePath,
            baseRef,
          );
        }
      }

      // Start the devcontainer
      await execFileAsync(
        "devcontainer",
        ["up", "--workspace-folder", workspacePath],
        { timeout: DEVCONTAINER_TIMEOUT },
      );

      return {
        path: workspacePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
      // Run postCreate hooks inside the workspace
      if (project.postCreate) {
        for (const command of project.postCreate) {
          await execFileAsync("sh", ["-c", command], {
            cwd: info.path,
            timeout: GIT_TIMEOUT,
          });
        }
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
