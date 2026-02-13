import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
  name: "clone",
  slot: "workspace" as const,
  description: "Workspace plugin: git clone isolation",
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
  const cloneBaseDir = config?.cloneDir
    ? expandPath(config.cloneDir as string)
    : join(homedir(), ".ao-clones");

  return {
    name: "clone",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const projectCloneDir = join(cloneBaseDir, cfg.projectId);
      const clonePath = join(projectCloneDir, cfg.sessionId);

      mkdirSync(projectCloneDir, { recursive: true });

      // Get the remote URL from the source repo
      let remoteUrl: string;
      try {
        remoteUrl = await git(repoPath, "remote", "get-url", "origin");
      } catch {
        // Fallback: use the local path as source
        remoteUrl = repoPath;
      }

      // Clone using --reference for faster clone with shared objects
      await execFileAsync("git", [
        "clone",
        "--reference",
        repoPath,
        "--branch",
        cfg.project.defaultBranch,
        remoteUrl,
        clonePath,
      ]);

      // Create and checkout the feature branch
      try {
        await git(clonePath, "checkout", "-b", cfg.branch);
      } catch {
        // Branch may exist on remote
        await git(clonePath, "checkout", cfg.branch);
      }

      return {
        path: clonePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      if (existsSync(workspacePath)) {
        rmSync(workspacePath, { recursive: true, force: true });
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectCloneDir = join(cloneBaseDir, projectId);
      if (!existsSync(projectCloneDir)) return [];

      const entries = readdirSync(projectCloneDir, { withFileTypes: true });
      const infos: WorkspaceInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const clonePath = join(projectCloneDir, entry.name);
        let branch: string;

        try {
          branch = await git(clonePath, "branch", "--show-current");
        } catch (err: unknown) {
          // Warn about corrupted clones instead of silently skipping
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console -- expected diagnostic for corrupted clones
          console.warn(`[workspace-clone] Skipping "${entry.name}": not a valid git repo (${msg})`);
          continue;
        }

        infos.push({
          path: clonePath,
          branch,
          sessionId: entry.name,
          projectId,
        });
      }

      return infos;
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
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
