/**
 * Tests for session-manager.ts private helper functions.
 *
 * Since getNextSessionNumber, safeJsonParse, validateStatus, metadataToSession,
 * and escapeRegex are module-private, we test them indirectly through the
 * exported createSessionManager and its methods.
 *
 * This file focuses on spawn edge cases, restore logic, and list/get behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Workspace,
  Tracker,
  RuntimeHandle,
  ActivityState,
} from "../types.js";

// ─── Factories ───────────────────────────────────────────────────────────────

let tmpDir: string;

function makeMockRuntime(): Runtime {
  return {
    name: "tmux",
    create: vi.fn().mockResolvedValue({ id: "rt-1", runtimeName: "tmux", data: {} }),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
    isAlive: vi.fn().mockResolvedValue(true),
  };
}

function makeMockAgent(): Agent {
  return {
    name: "claude-code",
    processName: "claude",
    getLaunchCommand: vi.fn().mockReturnValue("echo test"),
    getEnvironment: vi.fn().mockReturnValue({}),
    detectActivity: vi.fn().mockReturnValue("active" as ActivityState),
    getActivityState: vi.fn().mockResolvedValue(null),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };
}

function makeMockWorkspace(): Workspace {
  return {
    name: "worktree",
    create: vi.fn().mockResolvedValue({
      path: "/tmp/ws",
      branch: "feat/test",
      sessionId: "app-1",
      projectId: "my-app",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
}

function makeMockTracker(): Tracker {
  return {
    name: "github",
    getIssue: vi.fn().mockResolvedValue({
      id: "42",
      title: "Fix bug",
      description: "There is a bug",
      url: "https://github.com/org/repo/issues/42",
      state: "open",
      labels: [],
    }),
    isCompleted: vi.fn().mockResolvedValue(false),
    issueUrl: vi.fn().mockReturnValue("https://github.com/org/repo/issues/42"),
    branchName: vi.fn().mockReturnValue("feat/INT-42"),
    generatePrompt: vi.fn().mockResolvedValue("Work on issue #42"),
  };
}

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    configPath: join(tmpDir, "agent-orchestrator.yaml"),
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
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
    ...overrides,
  };
}

function makeRegistry(plugins: {
  runtime?: Runtime;
  agent?: Agent;
  workspace?: Workspace;
  tracker?: Tracker;
}): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, _name: string) => {
      if (slot === "runtime") return plugins.runtime ?? null;
      if (slot === "agent") return plugins.agent ?? null;
      if (slot === "workspace") return plugins.workspace ?? null;
      if (slot === "tracker") return plugins.tracker ?? null;
      if (slot === "scm") return null;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-sm-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(tmpDir, "my-app"), { recursive: true });
  // Create a minimal config file for hash generation
  writeFileSync(join(tmpDir, "agent-orchestrator.yaml"), "projects: {}\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("createSessionManager", () => {
  describe("spawn", () => {
    it("throws for unknown project", async () => {
      const config = makeConfig();
      const registry = makeRegistry({});
      const sm = createSessionManager({ config, registry });

      await expect(sm.spawn({ projectId: "nonexistent" })).rejects.toThrow("Unknown project");
    });

    it("throws when runtime plugin is not found", async () => {
      const config = makeConfig();
      const registry = makeRegistry({ agent: makeMockAgent() });
      const sm = createSessionManager({ config, registry });

      await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("Runtime plugin");
    });

    it("throws when agent plugin is not found", async () => {
      const config = makeConfig();
      const registry = makeRegistry({ runtime: makeMockRuntime() });
      const sm = createSessionManager({ config, registry });

      await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("Agent plugin");
    });

    it("spawns a session with auto-generated session ID", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      const session = await sm.spawn({ projectId: "my-app" });

      expect(session.id).toBe("app-1");
      expect(session.projectId).toBe("my-app");
      expect(session.status).toBe("spawning");
      expect(session.activity).toBe("active");
      expect(runtime.create).toHaveBeenCalled();
      expect(agent.getLaunchCommand).toHaveBeenCalled();
    });

    it("increments session number for existing sessions", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      const s1 = await sm.spawn({ projectId: "my-app" });
      expect(s1.id).toBe("app-1");

      const s2 = await sm.spawn({ projectId: "my-app" });
      expect(s2.id).toBe("app-2");
    });

    it("uses explicit branch when provided", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      const session = await sm.spawn({
        projectId: "my-app",
        branch: "my-custom-branch",
      });

      expect(session.branch).toBe("my-custom-branch");
    });

    it("generates session/sessionId branch when no issue or branch given", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      const session = await sm.spawn({ projectId: "my-app" });
      expect(session.branch).toBe("session/app-1");
    });

    it("uses tracker branch name when issue provided", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const tracker = makeMockTracker();
      const config = makeConfig();
      config.projects["my-app"].tracker = { plugin: "github" };
      const registry = makeRegistry({ runtime, agent, tracker });
      const sm = createSessionManager({ config, registry });

      const session = await sm.spawn({ projectId: "my-app", issueId: "42" });
      expect(session.branch).toBe("feat/INT-42");
      expect(tracker.branchName).toHaveBeenCalledWith("42", config.projects["my-app"]);
    });

    it("falls back to feat/issueId when tracker throws not-found", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const tracker = makeMockTracker();
      vi.mocked(tracker.getIssue).mockRejectedValue(new Error("Issue 99 not found"));
      const config = makeConfig();
      config.projects["my-app"].tracker = { plugin: "github" };
      const registry = makeRegistry({ runtime, agent, tracker });
      const sm = createSessionManager({ config, registry });

      // Even though getIssue fails, branchName is still called
      const session = await sm.spawn({ projectId: "my-app", issueId: "99" });
      expect(session.issueId).toBe("99");
    });

    it("throws when tracker fails with non-not-found error", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const tracker = makeMockTracker();
      vi.mocked(tracker.getIssue).mockRejectedValue(new Error("Auth failed: 401 Unauthorized"));
      const config = makeConfig();
      config.projects["my-app"].tracker = { plugin: "github" };
      const registry = makeRegistry({ runtime, agent, tracker });
      const sm = createSessionManager({ config, registry });

      await expect(sm.spawn({ projectId: "my-app", issueId: "42" })).rejects.toThrow(
        "Failed to fetch issue 42",
      );
    });

    it("writes metadata file on spawn", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      await sm.spawn({ projectId: "my-app" });

      const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta).not.toBeNull();
      expect(meta!["status"]).toBe("spawning");
      expect(meta!["project"]).toBe("my-app");
    });

    it("cleans up workspace on runtime creation failure", async () => {
      const runtime = makeMockRuntime();
      vi.mocked(runtime.create).mockRejectedValue(new Error("tmux failed"));
      const agent = makeMockAgent();
      const workspace = makeMockWorkspace();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent, workspace });
      const sm = createSessionManager({ config, registry });

      await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("tmux failed");
      expect(workspace.destroy).toHaveBeenCalled();
    });

    it("runs postLaunchSetup when available", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      agent.postLaunchSetup = vi.fn().mockResolvedValue(undefined);
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      await sm.spawn({ projectId: "my-app" });
      expect(agent.postLaunchSetup).toHaveBeenCalled();
    });

    it("cleans up on postLaunchSetup failure", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      agent.postLaunchSetup = vi.fn().mockRejectedValue(new Error("setup failed"));
      const workspace = makeMockWorkspace();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent, workspace });
      const sm = createSessionManager({ config, registry });

      await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("setup failed");
      expect(runtime.destroy).toHaveBeenCalled();
      expect(workspace.destroy).toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns empty array when no sessions exist", async () => {
      const config = makeConfig();
      const registry = makeRegistry({});
      const sm = createSessionManager({ config, registry });

      const sessions = await sm.list();
      expect(sessions).toEqual([]);
    });

    it("returns sessions from metadata files", async () => {
      const config = makeConfig();
      const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
      mkdirSync(sessionsDir, { recursive: true });
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/ws",
        branch: "feat/test",
        status: "working",
        project: "my-app",
      });

      const registry = makeRegistry({ runtime: makeMockRuntime(), agent: makeMockAgent() });
      const sm = createSessionManager({ config, registry });

      const sessions = await sm.list();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("app-1");
      expect(sessions[0].status).toBe("working");
    });

    it("filters by projectId", async () => {
      const config = makeConfig({
        projects: {
          "my-app": {
            name: "My App",
            repo: "org/my-app",
            path: join(tmpDir, "my-app"),
            defaultBranch: "main",
            sessionPrefix: "app",
          },
          "other-app": {
            name: "Other App",
            repo: "org/other",
            path: join(tmpDir, "other"),
            defaultBranch: "main",
            sessionPrefix: "oth",
          },
        },
      });
      mkdirSync(join(tmpDir, "other"), { recursive: true });

      const sessionsDir1 = getSessionsDir(config.configPath, config.projects["my-app"].path);
      const sessionsDir2 = getSessionsDir(config.configPath, config.projects["other-app"].path);
      mkdirSync(sessionsDir1, { recursive: true });
      mkdirSync(sessionsDir2, { recursive: true });

      writeMetadata(sessionsDir1, "app-1", {
        worktree: "/tmp/ws1",
        branch: "feat/1",
        status: "working",
        project: "my-app",
      });
      writeMetadata(sessionsDir2, "oth-1", {
        worktree: "/tmp/ws2",
        branch: "feat/2",
        status: "working",
        project: "other-app",
      });

      const registry = makeRegistry({ runtime: makeMockRuntime(), agent: makeMockAgent() });
      const sm = createSessionManager({ config, registry });

      const allSessions = await sm.list();
      expect(allSessions).toHaveLength(2);

      const filtered = await sm.list("my-app");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("app-1");
    });

    it("parses PR info from GitHub URL in metadata", async () => {
      const config = makeConfig();
      const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
      mkdirSync(sessionsDir, { recursive: true });
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/ws",
        branch: "feat/test",
        status: "pr_open",
        project: "my-app",
        pr: "https://github.com/org/my-app/pull/42",
      });

      const registry = makeRegistry({ runtime: makeMockRuntime(), agent: makeMockAgent() });
      const sm = createSessionManager({ config, registry });

      const sessions = await sm.list();
      expect(sessions[0].pr).not.toBeNull();
      expect(sessions[0].pr!.number).toBe(42);
      expect(sessions[0].pr!.owner).toBe("org");
      expect(sessions[0].pr!.repo).toBe("my-app");
    });

    it("normalizes 'starting' status to 'working'", async () => {
      const config = makeConfig();
      const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
      mkdirSync(sessionsDir, { recursive: true });
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/ws",
        branch: "feat/test",
        status: "starting", // legacy bash script status
        project: "my-app",
      });

      const registry = makeRegistry({ runtime: makeMockRuntime(), agent: makeMockAgent() });
      const sm = createSessionManager({ config, registry });

      const sessions = await sm.list();
      expect(sessions[0].status).toBe("working");
    });

    it("defaults unknown status to 'spawning'", async () => {
      const config = makeConfig();
      const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
      mkdirSync(sessionsDir, { recursive: true });
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/ws",
        branch: "feat/test",
        status: "invalid_status",
        project: "my-app",
      });

      const registry = makeRegistry({ runtime: makeMockRuntime(), agent: makeMockAgent() });
      const sm = createSessionManager({ config, registry });

      const sessions = await sm.list();
      expect(sessions[0].status).toBe("spawning");
    });
  });

  describe("get", () => {
    it("returns null for nonexistent session", async () => {
      const config = makeConfig();
      const registry = makeRegistry({});
      const sm = createSessionManager({ config, registry });

      const session = await sm.get("nonexistent");
      expect(session).toBeNull();
    });

    it("returns session when found", async () => {
      const config = makeConfig();
      const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
      mkdirSync(sessionsDir, { recursive: true });
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/ws",
        branch: "feat/test",
        status: "working",
        project: "my-app",
      });

      const registry = makeRegistry({ runtime: makeMockRuntime(), agent: makeMockAgent() });
      const sm = createSessionManager({ config, registry });

      const session = await sm.get("app-1");
      expect(session).not.toBeNull();
      expect(session!.id).toBe("app-1");
      expect(session!.status).toBe("working");
    });
  });

  describe("kill", () => {
    it("throws for nonexistent session", async () => {
      const config = makeConfig();
      const registry = makeRegistry({});
      const sm = createSessionManager({ config, registry });

      await expect(sm.kill("nonexistent")).rejects.toThrow("Session nonexistent not found");
    });

    it("destroys runtime and archives metadata", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      // Spawn first
      await sm.spawn({ projectId: "my-app" });

      // Kill
      await sm.kill("app-1");

      expect(runtime.destroy).toHaveBeenCalled();

      // Metadata should be archived (not in active directory)
      const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
      expect(readMetadataRaw(sessionsDir, "app-1")).toBeNull();
    });
  });

  describe("send", () => {
    it("throws for nonexistent session", async () => {
      const config = makeConfig();
      const registry = makeRegistry({});
      const sm = createSessionManager({ config, registry });

      await expect(sm.send("nonexistent", "hello")).rejects.toThrow("Session nonexistent not found");
    });

    it("sends message to runtime", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      await sm.spawn({ projectId: "my-app" });
      await sm.send("app-1", "hello world");

      expect(runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rt-1" }),
        "hello world",
      );
    });

    it("throws when runtime handle is corrupted", async () => {
      const config = makeConfig();
      const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
      mkdirSync(sessionsDir, { recursive: true });
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/ws",
        branch: "feat/test",
        status: "working",
        project: "my-app",
        runtimeHandle: "invalid-json{{{",
      });

      const runtime = makeMockRuntime();
      const registry = makeRegistry({ runtime });
      const sm = createSessionManager({ config, registry });

      await expect(sm.send("app-1", "hello")).rejects.toThrow("Corrupted runtime handle");
    });

    it("falls back to session ID as handle when runtimeHandle not stored", async () => {
      const config = makeConfig();
      const sessionsDir = getSessionsDir(config.configPath, config.projects["my-app"].path);
      mkdirSync(sessionsDir, { recursive: true });
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/ws",
        branch: "feat/test",
        status: "working",
        project: "my-app",
        // No runtimeHandle field
      });

      const runtime = makeMockRuntime();
      const registry = makeRegistry({ runtime });
      const sm = createSessionManager({ config, registry });

      await sm.send("app-1", "hello");

      expect(runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "app-1", runtimeName: "tmux" }),
        "hello",
      );
    });
  });

  describe("spawnOrchestrator", () => {
    it("throws for unknown project", async () => {
      const config = makeConfig();
      const registry = makeRegistry({});
      const sm = createSessionManager({ config, registry });

      await expect(sm.spawnOrchestrator({ projectId: "nonexistent" })).rejects.toThrow(
        "Unknown project",
      );
    });

    it("creates orchestrator session with '-orchestrator' suffix", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      const session = await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(session.id).toBe("app-orchestrator");
      expect(session.status).toBe("working");
      expect(session.projectId).toBe("my-app");
    });

    it("writes system prompt to file when provided", async () => {
      const runtime = makeMockRuntime();
      const agent = makeMockAgent();
      const config = makeConfig();
      const registry = makeRegistry({ runtime, agent });
      const sm = createSessionManager({ config, registry });

      await sm.spawnOrchestrator({
        projectId: "my-app",
        systemPrompt: "You are the orchestrator.",
      });

      // Agent should have been given a systemPromptFile
      expect(agent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPromptFile: expect.stringContaining("orchestrator-prompt.md"),
        }),
      );
    });
  });
});
