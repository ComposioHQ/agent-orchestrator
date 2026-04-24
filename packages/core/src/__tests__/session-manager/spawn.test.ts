import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import { createInitialCanonicalLifecycle } from "../../lifecycle-state.js";
import { getWorkspaceAgentsMdPath } from "../../opencode-agents-md.js";
import {
  writeMetadata,
  readMetadata,
  readMetadataRaw,
} from "../../metadata.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Workspace,
  Tracker,
} from "../../types.js";
import {
  setupTestContext,
  teardownTestContext,
  makeHandle,
  type TestContext,
} from "../test-utils.js";
import { installMockOpencode, installMockGit } from "./opencode-helpers.js";

let ctx: TestContext;
let tmpDir: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;
let originalPath: string | undefined;

beforeEach(() => {
  ctx = setupTestContext();
  ({
    tmpDir,
    sessionsDir,
    mockRuntime,
    mockAgent,
    mockWorkspace,
    mockRegistry,
    config,
    originalPath,
  } = ctx);
});

afterEach(() => {
  teardownTestContext(ctx);
});

describe("spawn", () => {
  it("creates a session with workspace, runtime, and agent", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.id).toBe("app-1");
    expect(session.status).toBe("spawning");
    expect(session.projectId).toBe("my-app");
    expect(session.runtimeHandle).toEqual(makeHandle("rt-1"));

    // Verify workspace was created
    expect(mockWorkspace.create).toHaveBeenCalled();
    // Verify agent launch command was requested
    expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
    // Verify runtime was created
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("uses issue ID to derive branch name", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(session.branch).toBe("feat/INT-100");
    expect(session.issueId).toBe("INT-100");
  });

  it("prefers tracker-provided Issue.branchName over tracker.branchName()", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({ branchName: "ABC-1234" }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("custom/INT-100-my-feature"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("ABC-1234");
  });

  it("uses tracker.branchName when Issue omits branchName", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-100",
        title: "T",
        description: "",
        url: "https://tracker.test/INT-100",
        state: "open",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("custom/INT-100-my-feature"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("custom/INT-100-my-feature");
    expect(mockTracker.branchName).toHaveBeenCalledWith("INT-100", expect.anything());
  });

  it("falls back to tracker.branchName when Issue.branchName is not git-safe", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-100",
        title: "T",
        description: "",
        url: "https://tracker.test/INT-100",
        state: "open",
        labels: [],
        branchName: "bad branch with spaces",
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("feat/INT-100");
  });

  it("sanitizes free-text issueId into a valid branch slug", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "fix login bug" });

    expect(session.branch).toBe("feat/fix-login-bug");
  });

  it("preserves casing for branch-safe issue IDs without tracker", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-9999" });

    expect(session.branch).toBe("feat/INT-9999");
  });

  it("sanitizes issueId with special characters", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({
      projectId: "my-app",
      issueId: "Fix: user can't login (SSO)",
    });

    expect(session.branch).toBe("feat/fix-user-can-t-login-sso");
  });

  it("truncates long slugs to 60 characters", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({
      projectId: "my-app",
      issueId:
        "this is a very long issue description that should be truncated to sixty characters maximum",
    });

    expect(session.branch!.replace("feat/", "").length).toBeLessThanOrEqual(60);
  });

  it("does not leave trailing dash after truncation", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    // Craft input where the 60th char falls on a word boundary (dash)
    const session = await sm.spawn({
      projectId: "my-app",
      issueId: "ab ".repeat(30), // "ab ab ab ..." → "ab-ab-ab-..." truncated at 60
    });

    const slug = session.branch!.replace("feat/", "");
    expect(slug).not.toMatch(/-$/);
    expect(slug).not.toMatch(/^-/);
  });

  it("falls back to sessionId when issueId sanitizes to empty string", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "!!!" });

    // Slug is empty after sanitization, falls back to sessionId
    expect(session.branch).toMatch(/^feat\/app-\d+$/);
  });

  it("sanitizes issueId containing '..' (invalid in git branch names)", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", issueId: "foo..bar" });

    // '..' is invalid in git refs, so it should be slugified
    expect(session.branch).toBe("feat/foo-bar");
  });

  it("uses tracker.branchName when tracker is available", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({}),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("custom/INT-100-my-feature"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });
    expect(session.branch).toBe("custom/INT-100-my-feature");
  });

  it("increments session numbers correctly", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    // Pre-create some metadata to simulate existing sessions
    writeMetadata(sessionsDir, "app-3", { worktree: "/tmp", branch: "b", status: "working" });
    writeMetadata(sessionsDir, "app-7", { worktree: "/tmp", branch: "b", status: "working" });

    const session = await sm.spawn({ projectId: "my-app" });
    expect(session.id).toBe("app-8");
  });

  it("does not reuse a killed session branch on recreate", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const first = await sm.spawn({ projectId: "my-app" });
    expect(first.id).toBe("app-1");
    expect(first.branch).toBe("session/app-1");

    await sm.kill(first.id);

    const second = await sm.spawn({ projectId: "my-app" });
    expect(second.id).toBe("app-2");
    expect(second.branch).toBe("session/app-2");
  });

  it("skips remote session branches when allocating a fresh session id", async () => {
    const mockGitBin = installMockGit(tmpDir, ["session/app-22"]);
    process.env.PATH = `${mockGitBin}:${originalPath ?? ""}`;
    mkdirSync(config.projects["my-app"]!.path, { recursive: true });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.id).toBe("app-23");
    expect(session.branch).toBe("session/app-23");
  });

  it("writes metadata file", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    const meta = readMetadata(sessionsDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("spawning");
    expect(meta!.project).toBe("my-app");
    expect(meta!.issue).toBe("INT-42");
  });

  it("reuses OpenCode session mapping by issue when available", async () => {
    const opencodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return opencodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    config = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "opencode",
        },
      },
    };

    writeMetadata(sessionsDir, "app-9", {
      worktree: "/tmp/old",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      createdAt: "2026-01-01T00:00:00.000Z",
      opencodeSessionId: "ses_existing",
    });

    const sm = createSessionManager({ config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_existing" }),
        }),
      }),
    );

    const metadata = readMetadataRaw(sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBe("ses_existing");
  });

  it("reuses most recent session-id candidate without relying on timestamps", async () => {
    const opencodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return opencodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    config = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "opencode",
        },
      },
    };

    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/old-no-ts",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_invalid_ts",
    });

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/new-with-ts",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_valid_newer",
    });

    const sm = createSessionManager({ config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_valid_newer" }),
        }),
      }),
    );

    const metadata = readMetadataRaw(sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBe("ses_valid_newer");
  });

  it("does not reuse issue mapping when opencodeIssueSessionStrategy is ignore", async () => {
    const opencodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return opencodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    config = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "opencode",
          opencodeIssueSessionStrategy: "ignore",
        },
      },
    };

    writeMetadata(sessionsDir, "app-9", {
      worktree: "/tmp/old",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_existing",
    });

    const sm = createSessionManager({ config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.not.objectContaining({ opencodeSessionId: expect.any(String) }),
        }),
      }),
    );

    const metadata = readMetadataRaw(sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBeUndefined();
  });

  it("deletes old issue mappings and starts fresh when opencodeIssueSessionStrategy is delete", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-issue.log");
    const mockBin = installMockOpencode(tmpDir, "[]", deleteLogPath);
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    const opencodeAgent: Agent = {
      ...mockAgent,
      name: "opencode",
    };

    const registryWithOpenCode: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return opencodeAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    config = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "opencode",
          opencodeIssueSessionStrategy: "delete",
        },
      },
    };

    writeMetadata(sessionsDir, "app-8", {
      worktree: "/tmp/old1",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_old_1",
    });
    writeMetadata(sessionsDir, "app-9", {
      worktree: "/tmp/old2",
      branch: "feat/INT-42",
      status: "killed",
      project: "my-app",
      issue: "INT-42",
      agent: "opencode",
      opencodeSessionId: "ses_old_2",
    });

    const sm = createSessionManager({ config, registry: registryWithOpenCode });
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-42" });

    const deleteLog = readFileSync(deleteLogPath, "utf-8");
    expect(deleteLog).toContain("session delete ses_old_1");
    expect(deleteLog).toContain("session delete ses_old_2");

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.not.objectContaining({ opencodeSessionId: expect.any(String) }),
        }),
      }),
    );

    const metadata = readMetadataRaw(sessionsDir, session.id);
    expect(metadata?.["opencodeSessionId"]).toBeUndefined();
  }, 15_000);

  it("throws for unknown project", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.spawn({ projectId: "nonexistent" })).rejects.toThrow("Unknown project");
  });

  it("throws when runtime plugin is missing", async () => {
    const emptyRegistry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockReturnValue(null),
    };

    const sm = createSessionManager({ config, registry: emptyRegistry });
    await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("not found");
  });

  describe("agent override", () => {
    let mockCodexAgent: Agent;
    let registryWithMultipleAgents: PluginRegistry;

    beforeEach(() => {
      mockCodexAgent = {
        name: "codex",
        processName: "codex",
        getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
        getEnvironment: vi.fn().mockReturnValue({ CODEX_VAR: "1" }),
        detectActivity: vi.fn().mockReturnValue("active"),
        getActivityState: vi.fn().mockResolvedValue(null),
        isProcessRunning: vi.fn().mockResolvedValue(true),
        getSessionInfo: vi.fn().mockResolvedValue(null),
      };

      registryWithMultipleAgents = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string, name: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") {
            if (name === "mock-agent") return mockAgent;
            if (name === "codex") return mockCodexAgent;
            return null;
          }
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };
    });

    it("uses overridden agent when spawnConfig.agent is provided", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app", agent: "codex" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(mockAgent.getLaunchCommand).not.toHaveBeenCalled();
    });

    it("throws when agent override plugin is not found", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await expect(sm.spawn({ projectId: "my-app", agent: "nonexistent" })).rejects.toThrow(
        "Agent plugin 'nonexistent' not found",
      );
    });

    it("uses default agent when no override specified", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app" });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalled();
      expect(mockCodexAgent.getLaunchCommand).not.toHaveBeenCalled();
    });

    it("persists agent name in metadata when override is used", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app", agent: "codex" });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta).not.toBeNull();
      expect(meta!["agent"]).toBe("codex");
    });

    it("persists default agent name in metadata when no override", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app" });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta).not.toBeNull();
      expect(meta!["agent"]).toBe("mock-agent");
    });

    it("uses project worker agent when configured and no spawn override is provided", async () => {
      const configWithWorkerAgent: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "mock-agent",
            worker: {
              agent: "codex",
            },
          },
        },
      };

      const sm = createSessionManager({
        config: configWithWorkerAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawn({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(mockAgent.getLaunchCommand).not.toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-1")?.["agent"]).toBe("codex");
    });

    it("uses defaults worker agent when project agent is not set", async () => {
      const configWithDefaultWorkerAgent: OrchestratorConfig = {
        ...config,
        defaults: {
          ...config.defaults,
          worker: {
            agent: "codex",
          },
        },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: undefined,
          },
        },
      };

      const sm = createSessionManager({
        config: configWithDefaultWorkerAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawn({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-1")?.["agent"]).toBe("codex");
    });

    it("readMetadata returns agent field (typed SessionMetadata)", async () => {
      const sm = createSessionManager({ config, registry: registryWithMultipleAgents });

      await sm.spawn({ projectId: "my-app", agent: "codex" });

      const meta = readMetadata(sessionsDir, "app-1");
      expect(meta).not.toBeNull();
      expect(meta!.agent).toBe("codex");
    });
  });

  it("forwards configured subagent to spawn launch when no override is provided", async () => {
    const configWithSubagent: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agentConfig: {
            subagent: "oracle",
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithSubagent,
      registry: mockRegistry,
    });
    await sm.spawn({ projectId: "my-app" });

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: "oracle" }),
    );
  });

  it("prefers spawn subagent override over configured subagent", async () => {
    const configWithSubagent: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agentConfig: {
            subagent: "oracle",
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithSubagent,
      registry: mockRegistry,
    });
    await sm.spawn({ projectId: "my-app", subagent: "librarian" });

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ subagent: "librarian" }),
    );
  });

  it("validates issue exists when issueId provided", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "INT-100",
        title: "Test issue",
        description: "Test description",
        url: "https://linear.app/test/issue/INT-100",
        state: "open",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue("https://linear.app/test/issue/INT-100"),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue("Work on INT-100"),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

    expect(mockTracker.getIssue).toHaveBeenCalledWith("INT-100", config.projects["my-app"]);
    expect(session.issueId).toBe("INT-100");
  });

  it("succeeds with ad-hoc issue string when tracker returns IssueNotFoundError", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("Issue INT-9999 not found")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-9999"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    // Ad-hoc issue string should succeed — IssueNotFoundError is gracefully ignored
    const session = await sm.spawn({ projectId: "my-app", issueId: "INT-9999" });

    expect(session.issueId).toBe("INT-9999");
    expect(session.branch).toBe("feat/INT-9999");
    // tracker.branchName and generatePrompt should NOT be called when issue wasn't resolved
    expect(mockTracker.branchName).not.toHaveBeenCalled();
    expect(mockTracker.generatePrompt).not.toHaveBeenCalled();
    // Workspace and runtime should still be created
    expect(mockWorkspace.create).toHaveBeenCalled();
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("succeeds with ad-hoc free-text when tracker returns 'invalid issue format'", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("invalid issue format: fix login bug")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue(""),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    const session = await sm.spawn({ projectId: "my-app", issueId: "fix login bug" });

    expect(session.issueId).toBe("fix login bug");
    expect(session.branch).toBe("feat/fix-login-bug");
    expect(mockTracker.branchName).not.toHaveBeenCalled();
    expect(mockWorkspace.create).toHaveBeenCalled();
  });

  it("fails on tracker auth errors", async () => {
    const mockTracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi.fn().mockRejectedValue(new Error("Unauthorized")),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue(""),
      branchName: vi.fn().mockReturnValue("feat/INT-100"),
      generatePrompt: vi.fn().mockResolvedValue(""),
    };

    const registryWithTracker: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "tracker") return mockTracker;
        return null;
      }),
    };

    const sm = createSessionManager({
      config,
      registry: registryWithTracker,
    });

    await expect(sm.spawn({ projectId: "my-app", issueId: "INT-100" })).rejects.toThrow(
      "Failed to fetch issue",
    );

    // Should not create workspace or runtime when auth fails
    expect(mockWorkspace.create).not.toHaveBeenCalled();
    expect(mockRuntime.create).not.toHaveBeenCalled();
  });

  it("spawns without issue tracking when no issueId provided", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app" });

    expect(session.issueId).toBeNull();
    // Uses session/{sessionId} to avoid conflicts with default branch
    expect(session.branch).toMatch(/^session\/app-\d+$/);
    expect(session.branch).not.toBe("main");
  });

  it("sends prompt post-launch when agent.promptDelivery is 'post-launch'", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return postLaunchAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });
    await vi.advanceTimersByTimeAsync(5_000);
    await spawnPromise;

    // Prompt should be sent via runtime.sendMessage, not included in launch command
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.stringContaining("Fix the bug"),
    );
    vi.useRealTimers();
  });

  it("does not send prompt post-launch when agent.promptDelivery is not set", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    // Default agent (no promptDelivery) should NOT trigger sendMessage for prompt
    expect(mockRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it("sends AO guidance post-launch even when no explicit prompt is provided", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return postLaunchAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app" });
    await vi.advanceTimersByTimeAsync(5_000);
    await spawnPromise;

    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.stringContaining("ao session claim-pr"),
    );
    vi.useRealTimers();
  });

  it("does not destroy session when post-launch prompt delivery fails", async () => {
    vi.useFakeTimers();
    const failingRuntime: Runtime = {
      ...mockRuntime,
      sendMessage: vi.fn().mockRejectedValue(new Error("tmux send failed")),
    };
    const postLaunchAgent = {
      ...mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithFailingSend: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return failingRuntime;
        if (slot === "agent") return postLaunchAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithFailingSend });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });
    // With retry logic (3 attempts at 3s, 6s, 9s delays before each attempt), need to advance 18s for all retries
    await vi.advanceTimersByTimeAsync(18_000);
    const session = await spawnPromise;

    // Session should still be returned successfully despite sendMessage failure
    expect(session.id).toBe("app-1");
    expect(session.status).toBe("spawning");
    // Runtime should NOT have been destroyed
    expect(failingRuntime.destroy).not.toHaveBeenCalled();
    // Verify promptDelivered is set to false in metadata
    expect(session.metadata.promptDelivered).toBe("false");
    vi.useRealTimers();
  }, 30_000);

  it("waits before sending post-launch prompt", async () => {
    vi.useFakeTimers();
    const postLaunchAgent = {
      ...mockAgent,
      promptDelivery: "post-launch" as const,
    };
    const registryWithPostLaunch: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return postLaunchAgent;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
    };

    const sm = createSessionManager({ config, registry: registryWithPostLaunch });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    // Advance only 2s — not enough, message should not have been sent yet
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockRuntime.sendMessage).not.toHaveBeenCalled();

    // Advance the remaining 1s — now the first attempt should fire (3s total = 3000 * 1)
    await vi.advanceTimersByTimeAsync(1_000);
    await spawnPromise;
    expect(mockRuntime.sendMessage).toHaveBeenCalled();
    vi.useRealTimers();
  }, 20_000);

  describe("displayName derivation", () => {
    it("persists the issue title as displayName when tracker returns one", async () => {
      const mockTracker: Tracker = {
        name: "mock-tracker",
        getIssue: vi.fn().mockResolvedValue({
          id: "INT-100",
          title: "Refactor session manager to use flat metadata files",
          description: "",
          url: "https://tracker.test/INT-100",
          state: "open",
          labels: [],
        }),
        isCompleted: vi.fn().mockResolvedValue(false),
        issueUrl: vi.fn().mockReturnValue(""),
        branchName: vi.fn().mockReturnValue("feat/INT-100"),
        generatePrompt: vi.fn().mockResolvedValue(""),
      };
      const registryWithTracker: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return mockAgent;
          if (slot === "workspace") return mockWorkspace;
          if (slot === "tracker") return mockTracker;
          return null;
        }),
      };

      const sm = createSessionManager({ config, registry: registryWithTracker });
      await sm.spawn({ projectId: "my-app", issueId: "INT-100" });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta?.["displayName"]).toBe("Refactor session manager to use flat metadata files");
    });

    it("persists the first line of a user prompt as displayName when there is no issue", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.spawn({
        projectId: "my-app",
        prompt:
          "Add rate limiting to /api/upload\n\nUse a sliding-window counter keyed by IP.",
      });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta?.["displayName"]).toBe("Add rate limiting to /api/upload");
    });

    it("truncates long displayName values with an ellipsis", async () => {
      const longPrompt =
        "Implement a comprehensive rate-limiter that supports sliding windows, token buckets, and per-route overrides with distributed counters";
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.spawn({ projectId: "my-app", prompt: longPrompt });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta?.["displayName"]).toBeDefined();
      expect(meta!["displayName"].length).toBeLessThanOrEqual(80);
      expect(meta!["displayName"].endsWith("…")).toBe(true);
    });

    it("truncates on code-point boundaries without splitting surrogate pairs", async () => {
      // Place a 4-byte emoji (2 UTF-16 code units) right where a naive
      // `slice(0, 79)` would split it, producing a lone surrogate.
      const prompt = "a".repeat(78) + "😀" + "b".repeat(20);
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.spawn({ projectId: "my-app", prompt });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      const displayName = meta?.["displayName"];
      expect(displayName).toBeDefined();
      expect(displayName!.endsWith("…")).toBe(true);
      // No lone surrogates — every code unit belongs to a valid code point.
      for (const ch of displayName!) {
        expect(ch.codePointAt(0)).toBeGreaterThan(0);
      }
      // Round-trip through UTF-8 should be lossless (no U+FFFD replacement).
      expect(Buffer.from(displayName!, "utf8").toString("utf8")).toBe(displayName);
    });

    it("does not write displayName when there is no issue or prompt", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });
      await sm.spawn({ projectId: "my-app" });

      const meta = readMetadataRaw(sessionsDir, "app-1");
      expect(meta?.["displayName"]).toBeUndefined();
    });
  });

  describe("spawnOrchestrator", () => {
    const projectPath = () => config.projects["my-app"]!.path;

    it("does not require a workspace plugin and runs from the project path", async () => {
      const registryNoWorkspace: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return mockAgent;
          return null;
        }),
      };
      const sm = createSessionManager({ config, registry: registryNoWorkspace });

      const session = await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(session.id).toBe("app-orchestrator");
      expect(session.workspacePath).toBe(projectPath());
      expect(session.branch).toBeNull();
      expect(mockRuntime.create).toHaveBeenCalled();
    });

    it("creates the canonical orchestrator session and reuses it on later calls", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      const first = await sm.spawnOrchestrator({ projectId: "my-app" });
      const second = await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(first.id).toBe("app-orchestrator");
      expect(second.id).toBe("app-orchestrator");
      expect(mockRuntime.create).toHaveBeenCalledTimes(1);
      expect(mockWorkspace.create).not.toHaveBeenCalled();
    });

    it("writes metadata with canonical orchestrator fields", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({ projectId: "my-app" });

      const meta = readMetadata(sessionsDir, "app-orchestrator");
      const raw = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta).not.toBeNull();
      expect(meta!.status).toBe("working");
      expect(meta!.project).toBe("my-app");
      expect(meta!.branch).toBe("");
      expect(meta!.tmuxName).toBeDefined();
      expect(meta!.runtimeHandle).toBeDefined();
      expect(raw?.["role"]).toBe("orchestrator");
      expect(raw?.["agent"]).toBe("mock-agent");
      expect(raw?.["worktree"]).toBe(projectPath());
    });

    it("calls agent.setupWorkspaceHooks on the project path", async () => {
      const agentWithHooks: Agent = {
        ...mockAgent,
        setupWorkspaceHooks: vi.fn().mockResolvedValue(undefined),
      };
      const registryWithHooks: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return agentWithHooks;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };

      const sm = createSessionManager({ config, registry: registryWithHooks });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(agentWithHooks.setupWorkspaceHooks).toHaveBeenCalledWith(
        projectPath(),
        expect.objectContaining({ dataDir: sessionsDir }),
      );
    });

    it("calls runtime.create with the project path and canonical session id", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockRuntime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: expect.stringContaining("-app-orchestrator"),
          workspacePath: projectPath(),
          launchCommand: "mock-agent --start",
          environment: expect.objectContaining({
            AO_SESSION: "app-orchestrator",
            AO_SESSION_NAME: "app-orchestrator",
            AO_PROJECT_ID: "my-app",
          }),
        }),
      );
    });

    it("cleans up metadata when runtime creation fails", async () => {
      (mockRuntime.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("runtime creation failed"),
      );
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
        "runtime creation failed",
      );

      expect(mockWorkspace.destroy).not.toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")).toBeNull();
    });

    it("cleans up metadata and runtime when post-launch setup fails", async () => {
      const postLaunchError = new Error("post-launch setup failed");
      const agentWithPostLaunch: typeof mockAgent = {
        ...mockAgent,
        postLaunchSetup: vi.fn().mockRejectedValueOnce(postLaunchError),
      };
      const registryWithPostLaunch: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return agentWithPostLaunch;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };
      const sm = createSessionManager({ config, registry: registryWithPostLaunch });

      await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
        "post-launch setup failed",
      );

      expect(mockRuntime.destroy).toHaveBeenCalled();
      expect(mockWorkspace.destroy).not.toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")).toBeNull();
    });

    it("deletes previous OpenCode orchestrator sessions before starting", async () => {
      const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator.log");
      const mockBin = installMockOpencode(
        tmpDir,
        JSON.stringify([
          { id: "ses_old", title: "AO:app-orchestrator", updated: "2025-01-01T00:00:00.000Z" },
          { id: "ses_new", title: "AO:app-orchestrator", updated: "2025-01-02T00:00:00.000Z" },
        ]),
        deleteLogPath,
      );
      process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

      const opencodeAgent: Agent = { ...mockAgent, name: "opencode" };
      const registryWithOpenCode: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return opencodeAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };
      const configWithDelete: OrchestratorConfig = {
        ...config,
        defaults: { ...config.defaults, agent: "opencode" },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "opencode",
            orchestratorSessionStrategy: "delete",
          },
        },
      };

      const sm = createSessionManager({ config: configWithDelete, registry: registryWithOpenCode });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      const deleteLog = readFileSync(deleteLogPath, "utf-8");
      expect(deleteLog).toContain("session delete ses_old");
      expect(deleteLog).toContain("session delete ses_new");
      expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "app-orchestrator",
          projectConfig: expect.objectContaining({
            agentConfig: expect.not.objectContaining({ opencodeSessionId: expect.any(String) }),
          }),
        }),
      );

      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["agent"]).toBe("opencode");
      expect(meta?.["opencodeSessionId"]).toBeUndefined();
    });

    it("discovers and persists OpenCode session ids by canonical title when strategy is reuse", async () => {
      const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator-reuse.log");
      const mockBin = installMockOpencode(
        tmpDir,
        JSON.stringify([
          {
            id: "ses_discovered_orchestrator",
            title: "AO:app-orchestrator",
            updated: 1_772_777_000_000,
          },
        ]),
        deleteLogPath,
      );
      process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

      const opencodeAgent: Agent = { ...mockAgent, name: "opencode" };
      const registryWithOpenCode: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return opencodeAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };
      const configWithReuse: OrchestratorConfig = {
        ...config,
        defaults: { ...config.defaults, agent: "opencode" },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "opencode",
            orchestratorSessionStrategy: "reuse",
          },
        },
      };

      const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          projectConfig: expect.objectContaining({
            agentConfig: expect.objectContaining({
              opencodeSessionId: "ses_discovered_orchestrator",
            }),
          }),
        }),
      );
      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["opencodeSessionId"]).toBe("ses_discovered_orchestrator");
    });

    it("uses project orchestrator agent when configured", async () => {
      const mockCodexAgent: Agent = {
        ...mockAgent,
        name: "codex",
        processName: "codex",
        getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
        getEnvironment: vi.fn().mockReturnValue({ CODEX_VAR: "1" }),
      };
      const registryWithMultipleAgents: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string, name: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "workspace") return mockWorkspace;
          if (slot === "agent") {
            if (name === "codex") return mockCodexAgent;
            if (name === "mock-agent") return mockAgent;
          }
          return null;
        }),
      };
      const configWithOrchestratorAgent: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "mock-agent",
            orchestrator: { agent: "codex" },
          },
        },
      };

      const sm = createSessionManager({
        config: configWithOrchestratorAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(mockAgent.getLaunchCommand).not.toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")?.["agent"]).toBe("codex");
    });

    it("uses defaults orchestrator agent when project agent is not set", async () => {
      const mockCodexAgent: Agent = {
        ...mockAgent,
        name: "codex",
        processName: "codex",
        getLaunchCommand: vi.fn().mockReturnValue("codex --start"),
        getEnvironment: vi.fn().mockReturnValue({ CODEX_VAR: "1" }),
      };
      const registryWithMultipleAgents: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string, name: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "workspace") return mockWorkspace;
          if (slot === "agent") {
            if (name === "codex") return mockCodexAgent;
            if (name === "mock-agent") return mockAgent;
          }
          return null;
        }),
      };
      const configWithDefaultOrchestratorAgent: OrchestratorConfig = {
        ...config,
        defaults: {
          ...config.defaults,
          orchestrator: { agent: "codex" },
        },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: undefined,
          },
        },
      };

      const sm = createSessionManager({
        config: configWithDefaultOrchestratorAgent,
        registry: registryWithMultipleAgents,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
      expect(readMetadataRaw(sessionsDir, "app-orchestrator")?.["agent"]).toBe("codex");
    });

    it("uses orchestratorModel and remains permissionless", async () => {
      const configWithOrchestratorModel: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agentConfig: {
              permissions: "suggest",
              model: "worker-model",
              orchestratorModel: "orchestrator-model",
            },
          },
        },
      };

      const sm = createSessionManager({
        config: configWithOrchestratorModel,
        registry: mockRegistry,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          permissions: "permissionless",
          model: "orchestrator-model",
          projectConfig: expect.objectContaining({
            agentConfig: expect.objectContaining({ permissions: "permissionless" }),
          }),
        }),
      );
    });

    it("forwards configured subagent to orchestrator launch", async () => {
      const configWithSubagent: OrchestratorConfig = {
        ...config,
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agentConfig: { subagent: "oracle" },
          },
        },
      };

      const sm = createSessionManager({
        config: configWithSubagent,
        registry: mockRegistry,
      });
      await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({ subagent: "oracle" }),
      );
    });

    it("writes system prompt to file and passes systemPromptFile to agent", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({
        projectId: "my-app",
        systemPrompt: "You are the orchestrator.",
      });

      expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "app-orchestrator",
          systemPromptFile: expect.stringContaining("orchestrator-prompt-app-orchestrator.md"),
        }),
      );

      const callArgs = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
      const promptFile = callArgs.systemPromptFile!;
      expect(existsSync(promptFile)).toBe(true);
      expect(readFileSync(promptFile, "utf-8")).toBe("You are the orchestrator.");
    });

    it("persists displayName derived from the orchestrator system prompt", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({
        projectId: "my-app",
        systemPrompt: "Audit test coverage for session-manager and open PRs for gaps",
      });

      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["displayName"]).toBe(
        "Audit test coverage for session-manager and open PRs for gaps",
      );
    });

    it("omits displayName when no system prompt is supplied", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await sm.spawnOrchestrator({ projectId: "my-app" });

      const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
      expect(meta?.["displayName"]).toBeUndefined();
    });

    it("writes the orchestrator AGENTS.md block into the project workspace for OpenCode", async () => {
      const opencodeAgent: Agent = { ...mockAgent, name: "opencode" };
      const registryWithOpenCode: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockImplementation((slot: string) => {
          if (slot === "runtime") return mockRuntime;
          if (slot === "agent") return opencodeAgent;
          if (slot === "workspace") return mockWorkspace;
          return null;
        }),
      };
      const configWithOpenCode: OrchestratorConfig = {
        ...config,
        defaults: { ...config.defaults, agent: "opencode" },
        projects: {
          ...config.projects,
          "my-app": {
            ...config.projects["my-app"],
            agent: "opencode",
          },
        },
      };

      const sm = createSessionManager({
        config: configWithOpenCode,
        registry: registryWithOpenCode,
      });

      await sm.spawnOrchestrator({
        projectId: "my-app",
        systemPrompt: "You are the orchestrator.",
      });

      const agentsMdPath = getWorkspaceAgentsMdPath(projectPath());
      expect(existsSync(agentsMdPath)).toBe(true);
      expect(readFileSync(agentsMdPath, "utf-8")).toBe(
        "<!-- AO_ORCHESTRATOR_PROMPT_START -->\n## Agent Orchestrator\n\nYou are the orchestrator.\n<!-- AO_ORCHESTRATOR_PROMPT_END -->\n",
      );

      expect(mockRuntime.create).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: expect.not.objectContaining({
            OPENCODE_CONFIG: expect.any(String),
          }),
        }),
      );
    }, 15_000);

    it("throws for unknown project", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(sm.spawnOrchestrator({ projectId: "nonexistent" })).rejects.toThrow(
        "Unknown project",
      );
    });

    it("throws when runtime plugin is missing", async () => {
      const emptyRegistry: PluginRegistry = {
        ...mockRegistry,
        get: vi.fn().mockReturnValue(null),
      };

      const sm = createSessionManager({ config, registry: emptyRegistry });

      await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow("not found");
    });

    it("returns session with runtimeHandle", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      const session = await sm.spawnOrchestrator({ projectId: "my-app" });

      expect(session.runtimeHandle).toEqual(makeHandle("rt-1"));
    });
  });

  describe("ensureOrchestrator", () => {
    function makeDeadOrchestratorLifecycle(timestamp: string) {
      const lifecycle = createInitialCanonicalLifecycle("orchestrator", new Date(timestamp));
      lifecycle.session.state = "terminated";
      lifecycle.session.reason = "runtime_lost";
      lifecycle.session.startedAt = timestamp;
      lifecycle.session.terminatedAt = timestamp;
      lifecycle.session.lastTransitionAt = timestamp;
      lifecycle.runtime.state = "missing";
      lifecycle.runtime.reason = "process_missing";
      lifecycle.runtime.lastObservedAt = timestamp;
      return lifecycle;
    }

    it("warns when legacy numbered orchestrator sessions still exist", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      writeMetadata(sessionsDir, "app-orchestrator-2", {
        worktree: config.projects["my-app"]!.path,
        branch: "",
        status: "working",
        project: "my-app",
        role: "orchestrator",
      });

      await sm.ensureOrchestrator({ projectId: "my-app", systemPrompt: "test" });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Legacy numbered orchestrator sessions detected"),
        expect.objectContaining({
          projectId: "my-app",
          legacySessionIds: ["app-orchestrator-2"],
        }),
      );

      warnSpy.mockRestore();
    });

    it("reuses the live canonical orchestrator when it already exists", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      writeMetadata(sessionsDir, "app-orchestrator", {
        worktree: config.projects["my-app"]!.path,
        branch: "",
        status: "working",
        project: "my-app",
        role: "orchestrator",
        createdAt: "2026-04-20T10:00:00.000Z",
      });

      const session = await sm.ensureOrchestrator({ projectId: "my-app", systemPrompt: "test" });

      expect(session.id).toBe("app-orchestrator");
      expect(mockRuntime.create).not.toHaveBeenCalled();
    });

    it("restores the canonical orchestrator when it is terminal but restorable", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      writeMetadata(sessionsDir, "app-orchestrator", {
        worktree: config.projects["my-app"]!.path,
        branch: "",
        status: "killed",
        project: "my-app",
        role: "orchestrator",
        createdAt: "2026-04-21T10:00:00.000Z",
        statePayload: JSON.stringify(makeDeadOrchestratorLifecycle("2026-04-21T10:00:00.000Z")),
      });

      const session = await sm.ensureOrchestrator({ projectId: "my-app", systemPrompt: "test" });

      expect(session.id).toBe("app-orchestrator");
      expect(mockRuntime.create).toHaveBeenCalledTimes(1);
    });

    it("falls through to create when restoring the canonical orchestrator fails", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockAgent.getRestoreCommand = vi
        .fn()
        .mockRejectedValueOnce(new Error("restore command failed"));

      writeMetadata(sessionsDir, "app-orchestrator", {
        worktree: config.projects["my-app"]!.path,
        branch: "",
        status: "killed",
        project: "my-app",
        role: "orchestrator",
        createdAt: "2026-04-21T10:00:00.000Z",
        statePayload: JSON.stringify(makeDeadOrchestratorLifecycle("2026-04-21T10:00:00.000Z")),
      });

      const session = await sm.ensureOrchestrator({ projectId: "my-app", systemPrompt: "test" });

      expect(session.id).toBe("app-orchestrator");
      expect(mockRuntime.create).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to restore orchestrator session during ensure; falling back",
        expect.objectContaining({ orchestratorId: "app-orchestrator" }),
      );
      warnSpy.mockRestore();
    });

    it("reuses the canonical orchestrator when concurrent ensure calls race to create it", async () => {
      const sm = createSessionManager({ config, registry: mockRegistry });

      const results = await Promise.allSettled([
        sm.ensureOrchestrator({ projectId: "my-app", systemPrompt: "test" }),
        sm.ensureOrchestrator({ projectId: "my-app", systemPrompt: "test" }),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]?.status).toBe("fulfilled");
      expect(results[1]?.status).toBe("fulfilled");

      if (results[0]?.status !== "fulfilled" || results[1]?.status !== "fulfilled") {
        throw new Error("Expected both ensureOrchestrator calls to fulfill");
      }

      expect(results[0].value.id).toBe("app-orchestrator");
      expect(results[1].value.id).toBe("app-orchestrator");
      expect(mockRuntime.create).toHaveBeenCalledTimes(1);
    });

    it("throws a clear error when the canonical orchestrator id collides with another project prefix", async () => {
      config.projects["other-app"] = {
        ...config.projects["my-app"]!,
        name: "Other App",
        storageKey: `${ctx.storageKey}-other`,
        path: join(tmpDir, "other-app"),
        sessionPrefix: "app-orchestrator",
      };

      const sm = createSessionManager({ config, registry: mockRegistry });

      await expect(
        sm.ensureOrchestrator({ projectId: "my-app", systemPrompt: "test" }),
      ).rejects.toThrow(/collides with sessionPrefix of project "other-app"/);
    });
  });
});
