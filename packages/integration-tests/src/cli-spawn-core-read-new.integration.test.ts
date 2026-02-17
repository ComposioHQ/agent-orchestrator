/**
 * Integration test for CLI spawn → Core session-manager with hash-based architecture.
 *
 * This test verifies that sessions work correctly with the new hash-based
 * project isolation architecture:
 * - Sessions stored in project-specific directories
 * - Hash-based namespacing prevents collisions
 * - tmuxName field correctly maps user-facing → tmux names
 * - Core session-manager finds sessions in new structure
 *
 * Requires:
 *   - tmux installed and running
 *   - git repository for worktree creation
 */

import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionManager,
  createPluginRegistry,
  type OrchestratorConfig,
  generateConfigHash,
  getSessionsDir,
  generateTmuxName,
} from "@composio/ao-core";
import { isTmuxAvailable, killSessionsByPrefix, killSession } from "./helpers/tmux.js";

const tmuxOk = await isTmuxAvailable();

describe.skipIf(!tmuxOk)("CLI-Core integration (hash-based architecture)", () => {
  let tmpDir: string;
  let configPath: string;
  let repoPath: string;
  const sessionPrefix = "ao-inttest-new";
  const sessionName = `${sessionPrefix}-1`;

  beforeAll(async () => {
    await killSessionsByPrefix(sessionPrefix);
    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-new-"));
    tmpDir = await realpath(raw);

    repoPath = join(tmpDir, "test-repo");

    // Create a minimal git repo
    mkdirSync(repoPath, { recursive: true });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    await execFileAsync("git", ["init"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    writeFileSync(join(repoPath, "README.md"), "# Test Repo");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });

    // Create config WITHOUT dataDir/worktreeDir (new architecture)
    const config = {
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
          sessionPrefix,
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
    // Cleanup tmux sessions
    for (let i = 1; i <= 3; i++) {
      await killSession(`${sessionPrefix}-${i}`).catch(() => {});
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("sessions are stored in hash-based project-specific directory", () => {
    // Calculate expected directory
    const hash = generateConfigHash(configPath);
    const sessionsDir = getSessionsDir(configPath, repoPath);

    expect(sessionsDir).toMatch(new RegExp(`\\.agent-orchestrator/${hash}-test-repo/sessions$`));
  });

  it("session metadata includes tmuxName field", () => {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    mkdirSync(sessionsDir, { recursive: true });

    // Write metadata as CLI would do
    const tmuxName = generateTmuxName(configPath, sessionPrefix, 1);
    const metadataPath = join(sessionsDir, sessionName);
    const metadata = [
      `worktree=${tmpDir}`,
      `branch=feat/test`,
      `status=spawning`,
      `project=test-project`,
      `issue=TEST-123`,
      `tmuxName=${tmuxName}`,
      `createdAt=${new Date().toISOString()}`,
    ].join("\n");
    writeFileSync(metadataPath, metadata + "\n");

    // Verify file exists in correct location
    expect(existsSync(metadataPath)).toBe(true);

    // Verify tmuxName field is present
    const content = readFileSync(metadataPath, "utf-8");
    expect(content).toContain(`tmuxName=${tmuxName}`);
    expect(content).toContain("project=test-project");
  });

  it("core session-manager finds session in hash-based directory", async () => {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    mkdirSync(sessionsDir, { recursive: true });

    // Write metadata
    const tmuxName = generateTmuxName(configPath, sessionPrefix, 1);
    const metadataPath = join(sessionsDir, sessionName);
    const metadata = [
      `worktree=${tmpDir}`,
      `branch=feat/test`,
      `status=working`,
      `project=test-project`,
      `issue=TEST-123`,
      `tmuxName=${tmuxName}`,
      `createdAt=${new Date().toISOString()}`,
    ].join("\n");
    writeFileSync(metadataPath, metadata + "\n");

    // Create session-manager with configPath
    const config: OrchestratorConfig = {
      configPath, // This enables hash-based architecture
      port: 3000,
      readyThresholdMs: 300_000,
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
          sessionPrefix,
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

    // List sessions
    const sessions = await sessionManager.list("test-project");

    // Verify session is found
    expect(sessions.length).toBeGreaterThan(0);
    const session = sessions.find((s) => s.id === sessionName);
    expect(session).toBeDefined();
    expect(session?.projectId).toBe("test-project");
    expect(session?.branch).toBe("feat/test");
    expect(session?.issueId).toBe("TEST-123");
    expect(session?.status).toBe("working");
  });

  it("tmux name includes hash for global uniqueness", () => {
    const hash = generateConfigHash(configPath);
    const tmuxName = generateTmuxName(configPath, sessionPrefix, 1);

    expect(tmuxName).toMatch(new RegExp(`^${hash}-${sessionPrefix}-1$`));
    expect(tmuxName).not.toBe(sessionName); // User-facing name is different
  });

  it("cross-project isolation with hash-based directories", async () => {
    // Create second project path
    const repo2Path = join(tmpDir, "project-b");
    const repoAPath = join(tmpDir, "project-a"); // Use separate path for project A
    mkdirSync(repo2Path, { recursive: true });
    mkdirSync(repoAPath, { recursive: true });

    const config: OrchestratorConfig = {
      configPath,
      port: 3000,
      readyThresholdMs: 300_000,
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
          path: repoAPath, // Different path from test-repo
          defaultBranch: "main",
          sessionPrefix: `${sessionPrefix}-a`,
        },
        "project-b": {
          name: "Project B",
          repo: "test/project-b",
          path: repo2Path,
          defaultBranch: "main",
          sessionPrefix: `${sessionPrefix}-b`,
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

    // Write metadata for project A
    const sessionsDirA = getSessionsDir(configPath, repoAPath);
    mkdirSync(sessionsDirA, { recursive: true });
    const sessionAName = `${sessionPrefix}-a-1`;
    writeFileSync(
      join(sessionsDirA, sessionAName),
      `worktree=${tmpDir}/a\nbranch=feat/A-100\nstatus=working\nproject=project-a\nissue=A-100\n`,
    );

    // Write metadata for project B
    const sessionsDirB = getSessionsDir(configPath, repo2Path);
    mkdirSync(sessionsDirB, { recursive: true });
    const sessionBName = `${sessionPrefix}-b-1`;
    writeFileSync(
      join(sessionsDirB, sessionBName),
      `worktree=${tmpDir}/b\nbranch=feat/B-100\nstatus=working\nproject=project-b\nissue=B-100\n`,
    );

    const registry = createPluginRegistry();
    const sessionManager = createSessionManager({ config, registry });

    // List sessions for each project
    const projectASessions = await sessionManager.list("project-a");
    const projectBSessions = await sessionManager.list("project-b");

    // Verify isolation
    expect(projectASessions.length).toBe(1);
    expect(projectBSessions.length).toBe(1);
    expect(projectASessions[0].id).toBe(sessionAName);
    expect(projectBSessions[0].id).toBe(sessionBName);

    // Verify sessions are in different directories
    expect(sessionsDirA).not.toBe(sessionsDirB);
    expect(sessionsDirA).toContain("project-a");
    expect(sessionsDirB).toContain("project-b");
  });
});
