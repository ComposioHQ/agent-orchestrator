import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  ProjectConfig,
} from "../types.js";
import {
  createTestEnvironment,
  createMockPlugins,
  createMockRegistry,
  createMockSessionManager,
  makeSession,
  type TestEnvironment,
  type MockPlugins,
} from "./test-utils.js";

let env: TestEnvironment;
let plugins: MockPlugins;
let mockRegistry: PluginRegistry;
let mockSessionManager: SessionManager;
let config: OrchestratorConfig;

beforeEach(() => {
  env = createTestEnvironment();
  plugins = createMockPlugins();
  mockRegistry = createMockRegistry({ runtime: plugins.runtime, agent: plugins.agent });
  mockSessionManager = createMockSessionManager();
  config = env.config;
});

afterEach(() => {
  env.cleanup();
});

function createLifecycle(overrides?: { projectId?: string; configOverride?: OrchestratorConfig }) {
  return createLifecycleManager({
    config: overrides?.configOverride ?? config,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
    projectId: overrides?.projectId,
  });
}

describe("recoverDeadSessions", () => {
  it("detects dead sessions and transitions them to terminated", async () => {
    // Write a session that appears "working" but whose runtime is dead
    writeMetadata(env.sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
      runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "mock", data: {} }),
    });

    // Runtime says the session is dead
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("app-1");
    expect(results[0].archived).toBe(true);
    expect(results[0].respawned).toBe(false); // no issueId

    // Session should be gone from active metadata
    expect(readMetadataRaw(env.sessionsDir, "app-1")).toBeNull();

    // Session should exist in archive
    const archiveDir = join(env.sessionsDir, "archive");
    expect(existsSync(archiveDir)).toBe(true);
    const archived = readdirSync(archiveDir);
    expect(archived.length).toBe(1);
    expect(archived[0]).toMatch(/^app-1_/);
  });

  it("respawns dead sessions that have an issueId", async () => {
    writeMetadata(env.sessionsDir, "app-2", {
      worktree: "/tmp/ws",
      branch: "feat/fix-bug",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
      issue: "GH-123",
      runtimeHandle: JSON.stringify({ id: "rt-2", runtimeName: "mock", data: {} }),
    });

    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(makeSession({ id: "app-3" }));

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("app-2");
    expect(results[0].issueId).toBe("GH-123");
    expect(results[0].archived).toBe(true);
    expect(results[0].respawned).toBe(true);
    expect(results[0].respawnError).toBeUndefined();

    // Verify spawn was called with correct args
    expect(mockSessionManager.spawn).toHaveBeenCalledWith({
      projectId: "my-app",
      issueId: "GH-123",
      agent: "mock-agent",
    });
  });

  it("skips sessions with terminal statuses", async () => {
    writeMetadata(env.sessionsDir, "app-done", {
      worktree: "/tmp/ws",
      branch: "feat/done",
      status: "done",
      project: "my-app",
    });

    writeMetadata(env.sessionsDir, "app-killed", {
      worktree: "/tmp/ws",
      branch: "feat/killed",
      status: "killed",
      project: "my-app",
    });

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(0);
  });

  it("skips sessions where the process is still alive", async () => {
    writeMetadata(env.sessionsDir, "app-alive", {
      worktree: "/tmp/ws",
      branch: "feat/alive",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
      runtimeHandle: JSON.stringify({ id: "rt-alive", runtimeName: "mock", data: {} }),
    });

    // Runtime says the session IS alive
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(true);

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(0);
    // Session should still be in active metadata
    expect(readMetadataRaw(env.sessionsDir, "app-alive")).not.toBeNull();
  });

  it("skips orchestrator sessions", async () => {
    writeMetadata(env.sessionsDir, "app-orchestrator", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      role: "orchestrator",
      runtimeHandle: JSON.stringify({ id: "rt-orch", runtimeName: "mock", data: {} }),
    });

    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(0);
  });

  it("handles spawn failure gracefully", async () => {
    writeMetadata(env.sessionsDir, "app-fail", {
      worktree: "/tmp/ws",
      branch: "feat/fail",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
      issue: "GH-456",
      runtimeHandle: JSON.stringify({ id: "rt-fail", runtimeName: "mock", data: {} }),
    });

    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);
    vi.mocked(mockSessionManager.spawn).mockRejectedValue(new Error("workspace conflict"));

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(1);
    expect(results[0].archived).toBe(true);
    expect(results[0].respawned).toBe(false);
    expect(results[0].respawnError).toBe("workspace conflict");
  });

  it("does not respawn when workerRespawnStrategy is fresh", async () => {
    // Set respawn strategy to "fresh" — which skips auto-respawn
    (config.projects["my-app"] as ProjectConfig).workerRespawnStrategy = "fresh";

    writeMetadata(env.sessionsDir, "app-fresh", {
      worktree: "/tmp/ws",
      branch: "feat/fresh",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
      issue: "GH-789",
      runtimeHandle: JSON.stringify({ id: "rt-fresh", runtimeName: "mock", data: {} }),
    });

    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(1);
    expect(results[0].archived).toBe(true);
    expect(results[0].respawned).toBe(false);
    expect(mockSessionManager.spawn).not.toHaveBeenCalled();
  });

  it("treats missing runtimeHandle as dead", async () => {
    // Session with no runtimeHandle — never fully started
    writeMetadata(env.sessionsDir, "app-nohandle", {
      worktree: "/tmp/ws",
      branch: "feat/nohandle",
      status: "spawning",
      project: "my-app",
      agent: "mock-agent",
    });

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(1);
    expect(results[0].sessionId).toBe("app-nohandle");
    expect(results[0].archived).toBe(true);
  });

  it("falls back to agent.isProcessRunning when runtime.isAlive fails", async () => {
    writeMetadata(env.sessionsDir, "app-fallback", {
      worktree: "/tmp/ws",
      branch: "feat/fallback",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
      runtimeHandle: JSON.stringify({ id: "rt-fb", runtimeName: "mock", data: {} }),
    });

    // Runtime throws, but agent says process is alive
    vi.mocked(plugins.runtime.isAlive).mockRejectedValue(new Error("runtime error"));
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(true);

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(0); // Still alive via agent check
  });

  it("recovers multiple dead sessions in one call", async () => {
    writeMetadata(env.sessionsDir, "app-a", {
      worktree: "/tmp/ws-a",
      branch: "feat/a",
      status: "working",
      project: "my-app",
      agent: "mock-agent",
      issue: "GH-1",
      runtimeHandle: JSON.stringify({ id: "rt-a", runtimeName: "mock", data: {} }),
    });

    writeMetadata(env.sessionsDir, "app-b", {
      worktree: "/tmp/ws-b",
      branch: "feat/b",
      status: "pr_open",
      project: "my-app",
      agent: "mock-agent",
      runtimeHandle: JSON.stringify({ id: "rt-b", runtimeName: "mock", data: {} }),
    });

    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);
    vi.mocked(mockSessionManager.spawn).mockResolvedValue(makeSession());

    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();

    expect(results).toHaveLength(2);
    // app-a has issueId, should be respawned
    const resultA = results.find((r) => r.sessionId === "app-a");
    expect(resultA?.respawned).toBe(true);
    // app-b has no issueId, should not be respawned
    const resultB = results.find((r) => r.sessionId === "app-b");
    expect(resultB?.respawned).toBe(false);
  });

  it("returns empty array when no sessions exist", async () => {
    const lm = createLifecycle({ projectId: "my-app" });
    const results = await lm.recoverDeadSessions();
    expect(results).toHaveLength(0);
  });
});
