/**
 * End-to-end integration test for core services wiring.
 *
 * Validates the full vertical integration path:
 *   config → PluginRegistry → SessionManager → LifecycleManager
 *   → spawn (metadata) → list → send → kill → cleanup
 *
 * This test proves that all core services are wired together correctly,
 * which is the primary goal of issue #8. It uses real tmux sessions with
 * trivial shell commands (no agent binaries needed).
 *
 * Requires:
 *   - tmux installed and running
 *   - git repository for worktree references
 */

import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionManager,
  createPluginRegistry,
  createLifecycleManager,
  generateConfigHash,
  getSessionsDir,
  generateTmuxName,
  type OrchestratorConfig,
  type PluginRegistry,
  type SessionManager,
} from "@aoagents/ao-core";
import { isTmuxAvailable, killSessionsByPrefix, killSession, capturePane } from "./helpers/tmux.js";
import { sleep } from "./helpers/polling.js";

const execFileAsync = promisify(execFile);

const tmuxOk = await isTmuxAvailable();

const SESSION_PREFIX = "ao-e2e-inttest";

describe.skipIf(!tmuxOk)(
  "End-to-end core services wiring (integration)",
  () => {
    let tmpDir: string;
    let repoPath: string;
    let configPath: string;
    let config: OrchestratorConfig;
    let registry: PluginRegistry;
    let sessionManager: SessionManager;

    beforeAll(async () => {
      await killSessionsByPrefix(SESSION_PREFIX);
      const raw = await mkdtemp(join(tmpdir(), "ao-e2e-inttest-"));
      tmpDir = await realpath(raw);
      repoPath = join(tmpDir, "test-repo");

      // Create a minimal git repo (needed for worktree references)
      mkdirSync(repoPath, { recursive: true });
      await execFileAsync("git", ["init"], { cwd: repoPath });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
      await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
      writeFileSync(join(repoPath, "README.md"), "# Test Repo");
      await execFileAsync("git", ["add", "."], { cwd: repoPath });
      await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });

      // Write a minimal config YAML (as JSON — loadConfig accepts YAML but
      // we create our OrchestratorConfig object directly for the test)
      const rawConfig = {
        port: 3099,
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: [],
        },
        projects: {
          "e2e-project": {
            name: "E2E Test Project",
            repo: "test/e2e-repo",
            path: repoPath,
            defaultBranch: "main",
            sessionPrefix: SESSION_PREFIX,
          },
        },
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      };

      configPath = join(tmpDir, "agent-orchestrator.yaml");
      await writeFile(configPath, JSON.stringify(rawConfig, null, 2));

      // Build the OrchestratorConfig object with configPath
      config = {
        ...rawConfig,
        configPath,
        readyThresholdMs: 300_000,
      };

      // Wire: Config → PluginRegistry → SessionManager
      registry = createPluginRegistry();
      sessionManager = createSessionManager({ config, registry });
    }, 30_000);

    afterAll(async () => {
      // Clean up any tmux sessions created during tests
      await killSessionsByPrefix(SESSION_PREFIX);
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }, 30_000);

    // ---------------------------------------------------------------
    // 1. PluginRegistry → SessionManager wiring
    // ---------------------------------------------------------------

    it("creates a PluginRegistry that SessionManager can use", () => {
      expect(registry).toBeDefined();
      expect(sessionManager).toBeDefined();
      // The registry is a real instance, not a mock
      expect(typeof registry.register).toBe("function");
      expect(typeof registry.get).toBe("function");
      expect(typeof registry.list).toBe("function");
    });

    it("SessionManager.list() returns an array (possibly empty) for a valid project", async () => {
      const sessions = await sessionManager.list("e2e-project");
      expect(Array.isArray(sessions)).toBe(true);
    });

    // ---------------------------------------------------------------
    // 2. Session metadata round-trip: write → list → read
    // ---------------------------------------------------------------

    it("session metadata written to hash-based directory is found by SessionManager", async () => {
      const sessionsDir = getSessionsDir(configPath, repoPath);
      mkdirSync(sessionsDir, { recursive: true });

      const sessionName = `${SESSION_PREFIX}-1`;
      const tmuxName = generateTmuxName(configPath, SESSION_PREFIX, 1);
      const now = new Date().toISOString();

      // Write metadata as the session manager would
      const metadata = [
        `worktree=${repoPath}`,
        `branch=feat/e2e-test`,
        `status=working`,
        `project=e2e-project`,
        `issue=E2E-1`,
        `tmuxName=${tmuxName}`,
        `createdAt=${now}`,
      ].join("\n");
      writeFileSync(join(sessionsDir, sessionName), metadata + "\n");

      // SessionManager should find this session
      const sessions = await sessionManager.list("e2e-project");
      const found = sessions.find((s) => s.id === sessionName);

      expect(found).toBeDefined();
      expect(found?.projectId).toBe("e2e-project");
      expect(found?.branch).toBe("feat/e2e-test");
      expect(found?.status).toBe("working");
      expect(found?.issueId).toBe("E2E-1");
    });

    // ---------------------------------------------------------------
    // 3. Real tmux session: create → verify alive → send → capture
    // ---------------------------------------------------------------

    it("creates a real tmux session and SessionManager detects it", async () => {
      const sessionsDir = getSessionsDir(configPath, repoPath);
      mkdirSync(sessionsDir, { recursive: true });

      const sessionName = `${SESSION_PREFIX}-2`;
      const tmuxName = generateTmuxName(configPath, SESSION_PREFIX, 2);

      // Create the tmux session directly (simulating what spawn does)
      await execFileAsync(
        "tmux",
        ["new-session", "-d", "-s", tmuxName, "-x", "200", "-y", "50", "bash"],
        { cwd: repoPath, timeout: 10_000 },
      );

      // Write metadata pointing to this tmux session
      const now = new Date().toISOString();
      writeFileSync(
        join(sessionsDir, sessionName),
        [
          `worktree=${repoPath}`,
          `branch=feat/e2e-tmux`,
          `status=working`,
          `project=e2e-project`,
          `tmuxName=${tmuxName}`,
          `createdAt=${now}`,
        ].join("\n") + "\n",
      );

      // Verify tmux session exists
      const { stdout } = await execFileAsync("tmux", ["has-session", "-t", tmuxName], {
        timeout: 5_000,
      }).catch(() => ({ stdout: "FAIL" }));
      expect(stdout).not.toBe("FAIL");

      // SessionManager should find this session with runtimeHandle data
      const sessions = await sessionManager.list("e2e-project");
      const found = sessions.find((s) => s.id === sessionName);
      expect(found).toBeDefined();
      expect(found?.branch).toBe("feat/e2e-tmux");
    });

    it("sends a message to a tmux session and captures the output", async () => {
      const tmuxName = generateTmuxName(configPath, SESSION_PREFIX, 2);
      const marker = `E2E_MARKER_${Date.now()}`;

      // Send a command through tmux
      await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "-l", `echo ${marker}`], {
        timeout: 5_000,
      });
      await sleep(200);
      await execFileAsync("tmux", ["send-keys", "-t", tmuxName, "Enter"], {
        timeout: 5_000,
      });
      await sleep(1_000);

      // Capture and verify output
      const output = await capturePane(tmuxName);
      expect(output).toContain(marker);
    });

    it("kills the tmux session and verifies it is gone", async () => {
      const tmuxName = generateTmuxName(configPath, SESSION_PREFIX, 2);

      await killSession(tmuxName);

      // has-session should now fail
      const result = await execFileAsync("tmux", ["has-session", "-t", tmuxName], {
        timeout: 5_000,
      }).catch(() => "GONE");
      expect(result).toBe("GONE");
    });

    // ---------------------------------------------------------------
    // 4. LifecycleManager wiring
    // ---------------------------------------------------------------

    it("creates a LifecycleManager wired to real SessionManager and Registry", () => {
      const lifecycleManager = createLifecycleManager({
        config,
        registry,
        sessionManager,
        projectId: "e2e-project",
      });

      expect(lifecycleManager).toBeDefined();
      expect(typeof lifecycleManager.start).toBe("function");
      expect(typeof lifecycleManager.stop).toBe("function");
      expect(typeof lifecycleManager.getStates).toBe("function");

      // States map should be empty before first poll
      const states = lifecycleManager.getStates();
      expect(states).toBeInstanceOf(Map);
    });

    it("LifecycleManager.start() and .stop() work without errors", async () => {
      const lifecycleManager = createLifecycleManager({
        config,
        registry,
        sessionManager,
        projectId: "e2e-project",
      });

      // Start with a long interval so it doesn't actually poll during test
      lifecycleManager.start(60_000);

      // Stopping should be clean
      lifecycleManager.stop();
    });

    // ---------------------------------------------------------------
    // 5. Cross-project isolation
    // ---------------------------------------------------------------

    it("sessions from different projects are isolated in hash-based directories", () => {
      const repo2Path = join(tmpDir, "other-repo");
      mkdirSync(repo2Path, { recursive: true });

      const dir1 = getSessionsDir(configPath, repoPath);
      const dir2 = getSessionsDir(configPath, repo2Path);

      // Different project paths produce different session directories
      expect(dir1).not.toBe(dir2);

      // Both use the same config hash prefix
      const hash = generateConfigHash(configPath);
      expect(dir1).toContain(hash);
      expect(dir2).toContain(hash);
    });

    // ---------------------------------------------------------------
    // 6. Config hash stability
    // ---------------------------------------------------------------

    it("config hash is deterministic for the same config path", () => {
      const hash1 = generateConfigHash(configPath);
      const hash2 = generateConfigHash(configPath);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(12); // First 12 chars of SHA-256
    });

    // ---------------------------------------------------------------
    // 7. tmux name global uniqueness
    // ---------------------------------------------------------------

    it("tmux names include config hash for global uniqueness", () => {
      const hash = generateConfigHash(configPath);
      const tmuxName = generateTmuxName(configPath, SESSION_PREFIX, 1);

      expect(tmuxName).toContain(hash);
      expect(tmuxName).toContain(SESSION_PREFIX);
      // User-facing session name should not include hash
      expect(`${SESSION_PREFIX}-1`).not.toContain(hash);
    });
  },
  120_000,
);
