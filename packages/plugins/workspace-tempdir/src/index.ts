import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
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

export const manifest = {
  name: "tempdir",
  slot: "workspace" as const,
  description: "Workspace plugin: shallow clone into temporary directory",
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

/**
 * Read the tracking file that maps session IDs to temp directories.
 * Returns a record of sessionId -> tempdir path.
 */
function readTrackingFile(trackingPath: string): Record<string, string> {
  try {
    const content = readFileSync(trackingPath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Write the tracking file */
function writeTrackingFile(
  trackingPath: string,
  data: Record<string, string>,
): void {
  writeFileSync(trackingPath, JSON.stringify(data, null, 2), "utf-8");
}

export function create(config?: Record<string, unknown>): Workspace {
  const trackingDir = config?.trackingDir
    ? expandPath(config.trackingDir as string)
    : join(homedir(), ".ao-tempdir");
  const trackingFileName = "sessions.json";

  function projectTrackingPath(projectId: string): string {
    return join(trackingDir, projectId, trackingFileName);
  }

  function setTracking(projectId: string, sessionId: string, workspacePath: string): void {
    const projectTrackingDir = join(trackingDir, projectId);
    mkdirSync(projectTrackingDir, { recursive: true });
    const trackingPath = projectTrackingPath(projectId);
    const tracking = readTrackingFile(trackingPath);
    tracking[sessionId] = workspacePath;
    writeTrackingFile(trackingPath, tracking);
  }

  function removeTrackingByWorkspacePath(workspacePath: string): void {
    if (!existsSync(trackingDir)) return;

    const projectDirs = readdirSync(trackingDir, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const trackingPath = projectTrackingPath(entry.name);
      const tracking = readTrackingFile(trackingPath);
      let changed = false;

      for (const [sessionId, trackedPath] of Object.entries(tracking)) {
        if (trackedPath === workspacePath) {
          delete tracking[sessionId];
          changed = true;
        }
      }

      if (changed) {
        writeTrackingFile(trackingPath, tracking);
      }
    }
  }

  return {
    name: "tempdir",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);

      // Create a temporary directory
      const prefix = `ao-${cfg.projectId}-${cfg.sessionId}-`;
      const tmpDir = mkdtempSync(join(tmpdir(), prefix));

      // Shallow clone from the project path
      try {
        await execFileAsync(
          "git",
          [
            "clone",
            "--depth",
            "1",
            "--branch",
            cfg.project.defaultBranch,
            repoPath,
            tmpDir,
          ],
          { timeout: GIT_TIMEOUT },
        );
      } catch (err: unknown) {
        // Clean up on failure
        rmSync(tmpDir, { recursive: true, force: true });
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to clone repo for session "${cfg.sessionId}": ${msg}`,
          { cause: err },
        );
      }

      // Create and checkout the feature branch
      try {
        await git(tmpDir, "checkout", "-b", cfg.branch);
      } catch (err: unknown) {
        rmSync(tmpDir, { recursive: true, force: true });
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to create branch "${cfg.branch}": ${msg}`,
          { cause: err },
        );
      }

      // Track the mapping from sessionId to tmpDir
      setTracking(cfg.projectId, cfg.sessionId, tmpDir);

      return {
        path: tmpDir,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      removeTrackingByWorkspacePath(workspacePath);

      if (existsSync(workspacePath)) {
        rmSync(workspacePath, { recursive: true, force: true });
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectTrackingDir = join(trackingDir, projectId);
      const trackingPath = join(projectTrackingDir, trackingFileName);
      const tracking = readTrackingFile(trackingPath);
      const infos: WorkspaceInfo[] = [];

      for (const [sessionId, tmpDir] of Object.entries(tracking)) {
        if (!existsSync(tmpDir)) continue;

        let branch: string;
        try {
          branch = await git(tmpDir, "branch", "--show-current");
        } catch {
          continue;
        }

        infos.push({
          path: tmpDir,
          branch,
          sessionId,
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

      // Clone fresh into the workspace path
      try {
        await execFileAsync(
          "git",
          [
            "clone",
            "--depth",
            "1",
            "--branch",
            cfg.project.defaultBranch,
            repoPath,
            workspacePath,
          ],
          { timeout: GIT_TIMEOUT },
        );
      } catch (err: unknown) {
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Clone failed during restore: ${msg}`, { cause: err });
      }

      // Try to checkout the branch
      try {
        await git(workspacePath, "checkout", cfg.branch);
      } catch {
        try {
          await git(workspacePath, "checkout", "-b", cfg.branch);
        } catch (err: unknown) {
          rmSync(workspacePath, { recursive: true, force: true });
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to checkout branch "${cfg.branch}" during restore: ${msg}`,
            { cause: err },
          );
        }
      }

      setTracking(cfg.projectId, cfg.sessionId, workspacePath);

      return {
        path: workspacePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async postCreate(
      info: WorkspaceInfo,
      project: ProjectConfig,
    ): Promise<void> {
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
