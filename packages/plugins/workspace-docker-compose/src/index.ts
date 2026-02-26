/**
 * workspace-docker-compose plugin — Docker Compose-based workspace isolation.
 *
 * Creates a workspace directory per session, copies/symlinks the project code,
 * and runs `docker compose up -d` for full container + network isolation.
 *
 * Expects docker-compose.yml or .docker-compose.yml in the project directory.
 * Uses execFile for all docker and git commands (never exec).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  copyFileSync,
  statSync,
} from "node:fs";
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
const COMPOSE_FILE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  ".docker-compose.yml",
  ".docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

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

/** Run a docker compose command in a given directory */
async function dockerCompose(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["compose", ...args], {
    cwd,
    timeout: CMD_TIMEOUT,
  });
  return stdout.trimEnd();
}

/**
 * Find the compose file in a directory.
 * Returns the file name if found, null otherwise.
 */
function findComposeFile(dir: string): string | null {
  for (const name of COMPOSE_FILE_NAMES) {
    const filePath = join(dir, name);
    if (existsSync(filePath)) {
      try {
        const stat = statSync(filePath);
        if (stat.isFile()) return name;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** Generate a deterministic compose project name from session/project IDs */
function composeProjectName(projectId: string, sessionId: string): string {
  return `ao-${projectId}-${sessionId}`;
}

// ---------------------------------------------------------------------------
// Workspace implementation
// ---------------------------------------------------------------------------

export const manifest = {
  name: "docker-compose",
  slot: "workspace" as const,
  description: "Workspace plugin: Docker Compose isolation",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Workspace {
  const workspaceBaseDir = config?.workspaceDir
    ? expandPath(config.workspaceDir as string)
    : join(homedir(), ".ao-compose-workspaces");

  return {
    name: "docker-compose",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const projectWorkspaceDir = join(workspaceBaseDir, cfg.projectId);
      const workspacePath = join(projectWorkspaceDir, cfg.sessionId);

      // 1. Find the compose file in the project
      const composeFileName = findComposeFile(repoPath);
      if (!composeFileName) {
        throw new Error(
          `No Docker Compose file found in project "${repoPath}". ` +
            `Expected one of: ${COMPOSE_FILE_NAMES.join(", ")}`,
        );
      }

      mkdirSync(projectWorkspaceDir, { recursive: true });

      // Fail early if workspace already exists
      if (existsSync(workspacePath)) {
        throw new Error(
          `Workspace path "${workspacePath}" already exists for session "${cfg.sessionId}" — destroy it before re-creating`,
        );
      }

      // 2. Clone the repo into the workspace directory
      let remoteUrl: string;
      try {
        remoteUrl = await git(repoPath, "remote", "get-url", "origin");
      } catch {
        remoteUrl = repoPath;
      }

      try {
        await execFileAsync(
          "git",
          [
            "clone",
            "--reference",
            repoPath,
            "--branch",
            cfg.project.defaultBranch,
            remoteUrl,
            workspacePath,
          ],
          { timeout: CMD_TIMEOUT },
        );
      } catch (cloneErr: unknown) {
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
        const msg = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
        throw new Error(`Failed to clone repo for session "${cfg.sessionId}": ${msg}`, {
          cause: cloneErr,
        });
      }

      // 3. Create and checkout feature branch
      try {
        await git(workspacePath, "checkout", "-b", cfg.branch);
      } catch {
        try {
          await git(workspacePath, "checkout", cfg.branch);
        } catch (checkoutErr: unknown) {
          rmSync(workspacePath, { recursive: true, force: true });
          const msg = checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
          throw new Error(`Failed to checkout branch "${cfg.branch}": ${msg}`, {
            cause: checkoutErr,
          });
        }
      }

      // 4. Copy the compose file if it's a dot-prefixed file (hidden) —
      //    otherwise the clone already has it
      if (composeFileName.startsWith(".")) {
        const sourceCompose = join(repoPath, composeFileName);
        const targetCompose = join(workspacePath, composeFileName);
        if (!existsSync(targetCompose)) {
          copyFileSync(sourceCompose, targetCompose);
        }
      }

      // 5. Start docker compose
      const projectName = composeProjectName(cfg.projectId, cfg.sessionId);
      try {
        await dockerCompose(
          workspacePath,
          "-p",
          projectName,
          "-f",
          composeFileName,
          "up",
          "-d",
        );
      } catch (composeErr: unknown) {
        // Compose failed — clean up
        rmSync(workspacePath, { recursive: true, force: true });
        const msg = composeErr instanceof Error ? composeErr.message : String(composeErr);
        throw new Error(`Docker Compose up failed for session "${cfg.sessionId}": ${msg}`, {
          cause: composeErr,
        });
      }

      return {
        path: workspacePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      const sessionId = basename(workspacePath);
      const projectId = basename(resolve(workspacePath, ".."));
      const projectName = composeProjectName(projectId, sessionId);

      // 1. Tear down compose services
      if (existsSync(workspacePath)) {
        const composeFileName = findComposeFile(workspacePath);
        if (composeFileName) {
          try {
            await dockerCompose(
              workspacePath,
              "-p",
              projectName,
              "-f",
              composeFileName,
              "down",
              "-v",
              "--remove-orphans",
            );
          } catch {
            // Best-effort: containers may have already been removed
          }
        }
      }

      // 2. Remove workspace directory
      if (existsSync(workspacePath)) {
        rmSync(workspacePath, { recursive: true, force: true });
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectWorkspaceDir = join(workspaceBaseDir, projectId);
      if (!existsSync(projectWorkspaceDir)) return [];

      const entries = readdirSync(projectWorkspaceDir, { withFileTypes: true });
      const infos: WorkspaceInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const workspacePath = join(projectWorkspaceDir, entry.name);
        let branch: string;

        try {
          branch = await git(workspacePath, "branch", "--show-current");
        } catch {
          continue;
        }

        infos.push({
          path: workspacePath,
          branch,
          sessionId: entry.name,
          projectId,
        });
      }

      return infos;
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
      // Run postCreate hooks via docker compose exec on the first service
      if (project.postCreate) {
        const projectName = composeProjectName(info.projectId, info.sessionId);
        const composeFileName = findComposeFile(info.path);
        if (!composeFileName) return;

        // Get the first service name
        let serviceName: string;
        try {
          const output = await dockerCompose(
            info.path,
            "-p",
            projectName,
            "-f",
            composeFileName,
            "ps",
            "--services",
          );
          const services = output.split("\n").filter((s) => s.trim().length > 0);
          if (services.length === 0) return;
          serviceName = services[0];
        } catch {
          return;
        }

        for (const command of project.postCreate) {
          await execFileAsync(
            "docker",
            ["compose", "-p", projectName, "-f", composeFileName, "exec", serviceName, "sh", "-c", command],
            { cwd: info.path, timeout: CMD_TIMEOUT },
          );
        }
      }
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;

      // Check git repo
      try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: workspacePath,
          timeout: CMD_TIMEOUT,
        });
      } catch {
        return false;
      }

      // Check that compose services are running
      const sessionId = basename(workspacePath);
      const projectId = basename(resolve(workspacePath, ".."));
      const projectName = composeProjectName(projectId, sessionId);
      const composeFileName = findComposeFile(workspacePath);
      if (!composeFileName) return false;

      try {
        const output = await dockerCompose(
          workspacePath,
          "-p",
          projectName,
          "-f",
          composeFileName,
          "ps",
          "--status",
          "running",
          "--services",
        );
        return output.trim().length > 0;
      } catch {
        return false;
      }
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      const repoPath = expandPath(cfg.project.path);

      // Find compose file in source project
      const composeFileName = findComposeFile(repoPath);
      if (!composeFileName) {
        throw new Error(
          `No Docker Compose file found in project "${repoPath}". ` +
            `Expected one of: ${COMPOSE_FILE_NAMES.join(", ")}`,
        );
      }

      // Get remote URL
      let remoteUrl: string;
      try {
        remoteUrl = await git(repoPath, "remote", "get-url", "origin");
      } catch {
        remoteUrl = repoPath;
      }

      // Ensure parent directory exists
      mkdirSync(resolve(workspacePath, ".."), { recursive: true });

      // Clone fresh
      try {
        await execFileAsync(
          "git",
          [
            "clone",
            "--reference",
            repoPath,
            "--branch",
            cfg.project.defaultBranch,
            remoteUrl,
            workspacePath,
          ],
          { timeout: CMD_TIMEOUT },
        );
      } catch (cloneErr: unknown) {
        rmSync(workspacePath, { recursive: true, force: true });
        const msg = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
        throw new Error(`Clone failed during restore: ${msg}`, { cause: cloneErr });
      }

      // Checkout branch
      try {
        await git(workspacePath, "checkout", cfg.branch);
      } catch {
        try {
          await git(workspacePath, "checkout", "-b", cfg.branch);
        } catch (checkoutErr: unknown) {
          rmSync(workspacePath, { recursive: true, force: true });
          const msg = checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
          throw new Error(
            `Failed to checkout branch "${cfg.branch}" during restore: ${msg}`,
            { cause: checkoutErr },
          );
        }
      }

      // Copy hidden compose file if needed
      if (composeFileName.startsWith(".")) {
        const sourceCompose = join(repoPath, composeFileName);
        const targetCompose = join(workspacePath, composeFileName);
        if (!existsSync(targetCompose)) {
          copyFileSync(sourceCompose, targetCompose);
        }
      }

      // Tear down any existing compose project
      const projectName = composeProjectName(cfg.projectId, cfg.sessionId);
      try {
        await dockerCompose(
          workspacePath,
          "-p",
          projectName,
          "-f",
          composeFileName,
          "down",
          "-v",
          "--remove-orphans",
        );
      } catch {
        // May not exist
      }

      // Start compose services
      await dockerCompose(
        workspacePath,
        "-p",
        projectName,
        "-f",
        composeFileName,
        "up",
        "-d",
      );

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
