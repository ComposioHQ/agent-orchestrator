import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, symlinkSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@agent-orchestrator/core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "worktree",
  slot: "workspace" as const,
  description: "Workspace plugin: git worktrees",
  version: "0.1.0",
};

/** Run a git command in a given directory */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

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

export function create(config?: Record<string, unknown>): Workspace {
  const worktreeBaseDir = config?.worktreeDir
    ? expandPath(config.worktreeDir as string)
    : join(homedir(), ".worktrees");

  return {
    name: "worktree",

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
        // Fetch may fail if offline — continue anyway
      }

      const baseRef = `origin/${cfg.project.defaultBranch}`;

      // Create worktree with a new branch
      try {
        await git(repoPath, "worktree", "add", "-b", cfg.branch, worktreePath, baseRef);
      } catch (err: unknown) {
        // Only retry if the error is "branch already exists"
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          throw new Error(`Failed to create worktree for branch "${cfg.branch}": ${msg}`, {
            cause: err,
          });
        }
        // Branch already exists — create worktree and check it out
        await git(repoPath, "worktree", "add", worktreePath, baseRef);
        await git(worktreePath, "checkout", cfg.branch);
      }

      return {
        path: worktreePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      // Find the main repo path from the worktree
      let branch: string | null = null;
      try {
        branch = await git(workspacePath, "branch", "--show-current");
      } catch {
        // May not be a valid git dir
      }

      try {
        const gitCommonDir = await git(
          workspacePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        // git-common-dir returns something like /path/to/repo/.git
        const repoPath = resolve(gitCommonDir, "..");
        await git(repoPath, "worktree", "remove", "--force", workspacePath);

        // Clean up the orphaned branch to prevent stale branch accumulation.
        // Guard: only delete feature branches (contain "/"), never default branches
        // like main, master, next, develop.
        if (branch && branch.includes("/")) {
          try {
            await git(repoPath, "branch", "-D", "--", branch);
          } catch {
            // Branch may be checked out elsewhere or already deleted
          }
        }
      } catch {
        // If git commands fail, try to clean up the directory
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
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(projectWorktreeDir, e.name));

      if (dirs.length === 0) return [];

      // Use first valid worktree to get the list
      let worktreeListOutput = "";
      for (const dir of dirs) {
        try {
          worktreeListOutput = await git(dir, "worktree", "list", "--porcelain");
          break;
        } catch {
          continue;
        }
      }

      if (!worktreeListOutput) return [];

      // Parse porcelain output — only include worktrees within our project directory
      const infos: WorkspaceInfo[] = [];
      const blocks = worktreeListOutput.split("\n\n");

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        let path = "";
        let branch = "";

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            path = line.slice("worktree ".length);
          } else if (line.startsWith("branch ")) {
            // branch refs/heads/feat/INT-1234 → feat/INT-1234
            branch = line.slice("branch ".length).replace("refs/heads/", "");
          }
        }

        if (path && (path === projectWorktreeDir || path.startsWith(projectWorktreeDir + "/"))) {
          const sessionId = basename(path);
          infos.push({
            path,
            branch: branch || "detached",
            sessionId,
            projectId,
          });
        }
      }

      return infos;
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
      const repoPath = expandPath(project.path);

      // Symlink shared resources
      if (project.symlinks) {
        for (const symlinkPath of project.symlinks) {
          // Guard against absolute paths and directory traversal
          if (symlinkPath.startsWith("/") || symlinkPath.includes("..")) {
            throw new Error(
              `Invalid symlink path "${symlinkPath}": must be a relative path without ".." segments`,
            );
          }

          const sourcePath = join(repoPath, symlinkPath);
          const targetPath = resolve(info.path, symlinkPath);

          // Verify resolved target is still within the workspace
          if (!targetPath.startsWith(info.path + "/") && targetPath !== info.path) {
            throw new Error(
              `Symlink target "${symlinkPath}" resolves outside workspace: ${targetPath}`,
            );
          }

          if (!existsSync(sourcePath)) continue;

          // Remove existing target if it exists
          try {
            const stat = lstatSync(targetPath);
            if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
              rmSync(targetPath, { recursive: true, force: true });
            }
          } catch {
            // Target doesn't exist — that's fine
          }

          // Ensure parent directory exists for nested symlink targets
          mkdirSync(dirname(targetPath), { recursive: true });
          symlinkSync(sourcePath, targetPath);
        }
      }

      // Run postCreate hooks
      // NOTE: commands run with full shell privileges — they come from trusted YAML config
      if (project.postCreate) {
        for (const command of project.postCreate) {
          await execFileAsync("sh", ["-c", command], { cwd: info.path });
        }
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
