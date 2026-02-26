import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

/** Timeout for mount/umount commands (30 seconds) */
const MOUNT_TIMEOUT = 30_000;

export const manifest = {
  name: "overlay",
  slot: "workspace" as const,
  description: "Workspace plugin: Linux OverlayFS isolation",
  version: "0.1.0",
};

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

function assertLinux(): void {
  if (platform() !== "linux") {
    throw new Error(
      "workspace-overlay requires Linux with OverlayFS support. " +
        "Current platform: " +
        platform(),
    );
  }
}

export function create(config?: Record<string, unknown>): Workspace {
  const overlayBaseDir = config?.overlayDir
    ? expandPath(config.overlayDir as string)
    : join(homedir(), ".ao-overlays");

  return {
    name: "overlay",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertLinux();
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const projectPath = expandPath(cfg.project.path);
      const sessionDir = join(overlayBaseDir, cfg.projectId, cfg.sessionId);
      const upperDir = join(sessionDir, "upper");
      const workDir = join(sessionDir, "work");
      const mergedDir = join(sessionDir, "merged");

      // Create all overlay directories
      mkdirSync(upperDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });
      mkdirSync(mergedDir, { recursive: true });

      // Mount the overlay filesystem
      const mountOptions = `lowerdir=${projectPath},upperdir=${upperDir},workdir=${workDir}`;
      await execFileAsync(
        "mount",
        ["-t", "overlay", "overlay", "-o", mountOptions, mergedDir],
        { timeout: MOUNT_TIMEOUT },
      );

      return {
        path: mergedDir,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      // Unmount the overlay
      try {
        await execFileAsync("umount", [workspacePath], {
          timeout: MOUNT_TIMEOUT,
        });
      } catch {
        // May already be unmounted
      }

      // Remove the entire session directory (upper, work, merged)
      // workspacePath is .../merged, parent is the session dir
      const sessionDir = join(workspacePath, "..");
      if (existsSync(sessionDir)) {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectDir = join(overlayBaseDir, projectId);
      if (!existsSync(projectDir)) return [];

      const entries = readdirSync(projectDir, { withFileTypes: true });
      const infos: WorkspaceInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const mergedDir = join(projectDir, entry.name, "merged");
        if (!existsSync(mergedDir)) continue;

        // Try to detect branch from git in the merged dir
        let branch = "unknown";
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["branch", "--show-current"],
            { cwd: mergedDir, timeout: 30_000 },
          );
          branch = stdout.trim() || "unknown";
        } catch {
          // Not a git repo or git not available in overlay
        }

        infos.push({
          path: mergedDir,
          branch,
          sessionId: entry.name,
          projectId,
        });
      }

      return infos;
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;
      // Check if the overlay is mounted by verifying mount point
      try {
        const { stdout } = await execFileAsync(
          "mountpoint",
          ["-q", workspacePath],
          { timeout: 30_000 },
        );
        // mountpoint -q returns 0 if it's a mountpoint
        return true;
      } catch {
        // Not a mountpoint — directory exists but overlay is not mounted
        return existsSync(workspacePath);
      }
    },

    async restore(
      cfg: WorkspaceCreateConfig,
      workspacePath: string,
    ): Promise<WorkspaceInfo> {
      assertLinux();

      const projectPath = expandPath(cfg.project.path);
      // workspacePath is .../merged, derive session dir structure
      const sessionDir = join(workspacePath, "..");
      const upperDir = join(sessionDir, "upper");
      const workDir = join(sessionDir, "work");

      // Ensure directories exist
      mkdirSync(upperDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });
      mkdirSync(workspacePath, { recursive: true });

      // Remount the overlay
      const mountOptions = `lowerdir=${projectPath},upperdir=${upperDir},workdir=${workDir}`;
      await execFileAsync(
        "mount",
        ["-t", "overlay", "overlay", "-o", mountOptions, workspacePath],
        { timeout: MOUNT_TIMEOUT },
      );

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
      // Run postCreate hooks inside the merged workspace
      if (project.postCreate) {
        for (const command of project.postCreate) {
          await execFileAsync("sh", ["-c", command], {
            cwd: info.path,
            timeout: MOUNT_TIMEOUT,
          });
        }
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
