/**
 * Integration test for CLI spawn → Core session-manager integration.
 *
 * This test verifies that sessions spawned via CLI commands can be read
 * by the core session-manager (used by the dashboard). It would have caught
 * the metadata path mismatch bug where CLI wrote to project-specific
 * subdirectories while core read from flat directory.
 *
 * Requires:
 *   - tmux installed and running
 *   - git repository for worktree creation
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionManager, createPluginRegistry, type OrchestratorConfig } from "@composio/ao-core";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  killSession,
} from "./helpers/tmux.js";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "ao-inttest-metadata-";
const tmuxOk = await isTmuxAvailable();

describe.skipIf(!tmuxOk)("CLI-Core metadata integration", () => {
  let tmpDir: string;
  let configPath: string;
  let dataDir: string;
  let worktreeDir: string;
  let repoPath: string;
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-metadata-"));
    tmpDir = await realpath(raw);

    dataDir = join(tmpDir, ".ao-sessions");
    worktreeDir = join(tmpDir, "worktrees");
    repoPath = join(tmpDir, "test-repo");

    // Create a minimal git repo for worktree operations
    mkdirSync(repoPath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    writeFileSync(join(repoPath, "README.md"), "# Test Repo");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });

    // Create config file
    const config = {
      dataDir,
      worktreeDir,
      port: 3000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        "test-project": {
          name: "Test Project",
          repo: "test/test-repo",
          path: repoPath,
          defaultBranch: "main",
          sessionPrefix: SESSION_PREFIX.replace(/-$/, ""),
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };

    configPath = join(tmpDir, "agent-orchestrator.yaml");
    await writeFile(configPath, JSON.stringify(config, null, 2));
  }, 30_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("session spawned by CLI metadata helpers is readable by core session-manager", async () => {
    // Step 1: Simulate what CLI spawn.ts does - write metadata to flat directory
    mkdirSync(dataDir, { recursive: true });
    const metadataPath = join(dataDir, sessionName);
    const metadata = [
      `worktree=${tmpDir}`,
      `branch=feat/test`,
      `status=spawning`,
      `project=test-project`,
      `issue=TEST-123`,
      `createdAt=${new Date().toISOString()}`,
    ].join("\n");
    writeFileSync(metadataPath, metadata + "\n");

    // Verify metadata file was created in flat directory
    expect(existsSync(metadataPath)).toBe(true);

    // Step 2: Use core session-manager to read the session
    const config: OrchestratorConfig = {
      dataDir,
      worktreeDir,
      port: 3000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        "test-project": {
          name: "Test Project",
          repo: "test/test-repo",
          path: repoPath,
          defaultBranch: "main",
          sessionPrefix: SESSION_PREFIX.replace(/-$/, ""),
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };

    const registry = createPluginRegistry();
    const sessionManager = createSessionManager({ config, registry });

    // List sessions - should find the one we just created
    const sessions = await sessionManager.list("test-project");

    // Step 3: Verify core session-manager found the session
    expect(sessions.length).toBeGreaterThan(0);
    const session = sessions.find((s) => s.id === sessionName);
    expect(session).toBeDefined();
    expect(session?.projectId).toBe("test-project");
    expect(session?.branch).toBe("feat/test");
    expect(session?.issueId).toBe("TEST-123");
    expect(session?.status).toBe("spawning");
  });

  it("verifies metadata written to project-specific subdir would NOT be found by core (regression test)", async () => {
    // This test verifies the OLD BUG - if CLI writes to project-specific subdir,
    // core session-manager won't find it

    const legacySessionName = `${SESSION_PREFIX}legacy-${Date.now()}`;

    // Step 1: Write metadata to project-specific subdirectory (OLD BUG behavior)
    const projectSubdir = join(dataDir, "test-project-sessions");
    mkdirSync(projectSubdir, { recursive: true });
    const legacyMetadataPath = join(projectSubdir, legacySessionName);
    const metadata = [
      `worktree=${tmpDir}`,
      `branch=feat/legacy`,
      `status=spawning`,
      `project=test-project`,
    ].join("\n");
    writeFileSync(legacyMetadataPath, metadata + "\n");

    expect(existsSync(legacyMetadataPath)).toBe(true);

    // Step 2: Try to read with core session-manager
    const config: OrchestratorConfig = {
      dataDir,
      worktreeDir,
      port: 3000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        "test-project": {
          name: "Test Project",
          repo: "test/test-repo",
          path: repoPath,
          defaultBranch: "main",
          sessionPrefix: SESSION_PREFIX.replace(/-$/, ""),
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };

    const registry = createPluginRegistry();
    const sessionManager = createSessionManager({ config, registry });
    const sessions = await sessionManager.list("test-project");

    // Step 3: Verify core session-manager CANNOT find the legacy session
    const legacySession = sessions.find((s) => s.id === legacySessionName);
    expect(legacySession).toBeUndefined(); // This proves the bug existed
  });

  it("verifies cross-project isolation with flat directory structure", async () => {
    // This test verifies that the flat directory structure correctly isolates
    // sessions by project using the project field in metadata

    const projectASession = `${SESSION_PREFIX}project-a-${Date.now()}`;
    const projectBSession = `${SESSION_PREFIX}project-b-${Date.now()}`;

    // Create metadata for two projects with same issue ID
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, projectASession),
      `worktree=${tmpDir}/a\nbranch=feat/INT-100\nstatus=working\nproject=project-a\nissue=INT-100\n`,
    );

    writeFileSync(
      join(dataDir, projectBSession),
      `worktree=${tmpDir}/b\nbranch=feat/INT-100\nstatus=working\nproject=project-b\nissue=INT-100\n`,
    );

    const config: OrchestratorConfig = {
      dataDir,
      worktreeDir,
      port: 3000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        "project-a": {
          name: "Project A",
          repo: "test/project-a",
          path: repoPath,
          defaultBranch: "main",
          sessionPrefix: SESSION_PREFIX.replace(/-$/, ""),
        },
        "project-b": {
          name: "Project B",
          repo: "test/project-b",
          path: repoPath,
          defaultBranch: "main",
          sessionPrefix: SESSION_PREFIX.replace(/-$/, ""),
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };

    const registry = createPluginRegistry();
    const sessionManager = createSessionManager({ config, registry });

    // List sessions for project-a
    const projectASessions = await sessionManager.list("project-a");
    const foundA = projectASessions.find((s) => s.id === projectASession);
    const foundBInA = projectASessions.find((s) => s.id === projectBSession);

    // List sessions for project-b
    const projectBSessions = await sessionManager.list("project-b");
    const foundB = projectBSessions.find((s) => s.id === projectBSession);
    const foundAInB = projectBSessions.find((s) => s.id === projectASession);

    // Verify isolation: each project only sees its own sessions
    expect(foundA).toBeDefined();
    expect(foundBInA).toBeUndefined();
    expect(foundB).toBeDefined();
    expect(foundAInB).toBeUndefined();
  });
});
