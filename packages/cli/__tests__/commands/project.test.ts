import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import type { GlobalConfig, SessionManager } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockLoadGlobalConfig,
  mockSaveGlobalConfig,
  mockRegisterProject,
  mockUnregisterProject,
  mockDeleteShadowFile,
  mockScaffoldGlobalConfig,
  mockDetectConfigMode,
  mockFindLocalConfigPath,
  mockLoadLocalProjectConfig,
  mockSyncShadow,
  mockMatchProjectByCwd,
  mockFindProjectByPath,
  mockLoadConfig,
  mockGenerateSessionPrefix,
  mockGenerateProjectId,
  mockExpandHome,
  mockSessionManager,
  mockStopLifecycleWorker,
  mockPromptConfirm,
  mockIsHumanCaller,
} = vi.hoisted(() => ({
  mockLoadGlobalConfig: vi.fn(),
  mockSaveGlobalConfig: vi.fn(),
  mockRegisterProject: vi.fn(),
  mockUnregisterProject: vi.fn(),
  mockDeleteShadowFile: vi.fn(),
  mockScaffoldGlobalConfig: vi.fn(),
  mockDetectConfigMode: vi.fn().mockReturnValue("global-only"),
  mockFindLocalConfigPath: vi.fn().mockReturnValue(null),
  mockLoadLocalProjectConfig: vi.fn(),
  mockSyncShadow: vi.fn(),
  mockMatchProjectByCwd: vi.fn().mockReturnValue(null),
  mockFindProjectByPath: vi.fn().mockReturnValue(null),
  mockLoadConfig: vi.fn(),
  mockGenerateSessionPrefix: vi.fn((s: string) => s.slice(0, 2)),
  mockGenerateProjectId: vi.fn((p: string) => p.split("/").pop() ?? p),
  mockExpandHome: vi.fn((p: string) => p),
  mockSessionManager: {
    list: vi.fn().mockResolvedValue([]),
    kill: vi.fn(),
    cleanup: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  },
  mockStopLifecycleWorker: vi.fn().mockResolvedValue(false),
  mockPromptConfirm: vi.fn().mockResolvedValue(true),
  mockIsHumanCaller: vi.fn().mockReturnValue(false),
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadGlobalConfig: mockLoadGlobalConfig,
    saveGlobalConfig: mockSaveGlobalConfig,
    registerProject: mockRegisterProject,
    unregisterProject: mockUnregisterProject,
    deleteShadowFile: mockDeleteShadowFile,
    scaffoldGlobalConfig: mockScaffoldGlobalConfig,
    detectConfigMode: mockDetectConfigMode,
    findLocalConfigPath: mockFindLocalConfigPath,
    loadLocalProjectConfig: mockLoadLocalProjectConfig,
    syncShadow: mockSyncShadow,
    matchProjectByCwd: mockMatchProjectByCwd,
    findProjectByPath: mockFindProjectByPath,
    loadConfig: mockLoadConfig,
    generateSessionPrefix: mockGenerateSessionPrefix,
    generateProjectId: mockGenerateProjectId,
    expandHome: mockExpandHome,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as unknown as SessionManager,
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  stopLifecycleWorker: (...args: unknown[]) => mockStopLifecycleWorker(...args),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: (...args: unknown[]) => mockPromptConfirm(...args),
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: () => mockIsHumanCaller(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { registerProjectCommand } from "../../src/commands/project.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGlobalConfig(
  projectIds: string[] = ["my-project"],
): GlobalConfig {
  const projects: GlobalConfig["projects"] = {};
  for (const id of projectIds) {
    projects[id] = { name: id, path: `/home/user/${id}` } as GlobalConfig["projects"][string];
  }
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: ["composio", "desktop"] },
    projects,
  } as GlobalConfig;
}

function runCommand(args: string[]): Promise<Command> {
  const program = new Command();
  program.exitOverride();
  registerProjectCommand(program);
  return program.parseAsync(["node", "ao", ...args]);
}

// ---------------------------------------------------------------------------
// ao project list
// ---------------------------------------------------------------------------

describe("ao project list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectConfigMode.mockReturnValue("global-only");
  });

  it("lists registered projects", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["app", "api"]));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCommand(["project", "list"]);
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("app");
    expect(output).toContain("api");
    spy.mockRestore();
  });

  it("shows message when no global config", async () => {
    mockLoadGlobalConfig.mockReturnValue(null);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCommand(["project", "list"]);
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("No global config");
    spy.mockRestore();
  });

  it("shows message when no projects registered", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCommand(["project", "list"]);
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("No projects");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ao project add
// ---------------------------------------------------------------------------

describe("ao project add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectConfigMode.mockReturnValue("global-only");
    mockFindLocalConfigPath.mockReturnValue(null);
    mockMatchProjectByCwd.mockReturnValue(null);
    mockFindProjectByPath.mockReturnValue(null);
    mockExpandHome.mockImplementation((p: string) => p);
    mockGenerateProjectId.mockImplementation((p: string) => p.split("/").pop() ?? p);
    mockGenerateSessionPrefix.mockImplementation((s: string) => s.slice(0, 2));
    mockRegisterProject.mockImplementation((cfg: GlobalConfig, id: string, entry: unknown) => ({
      ...cfg,
      projects: { ...cfg.projects, [id]: entry },
    }));
  });

  it("registers a new global-only project", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    await runCommand(["project", "add", "/home/user/my-app"]);
    expect(mockRegisterProject).toHaveBeenCalled();
    expect(mockSaveGlobalConfig).toHaveBeenCalled();
  });

  it("scaffolds global config when none exists", async () => {
    mockLoadGlobalConfig.mockReturnValue(null);
    mockScaffoldGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    await runCommand(["project", "add", "/home/user/new-app"]);
    expect(mockScaffoldGlobalConfig).toHaveBeenCalled();
    expect(mockRegisterProject).toHaveBeenCalled();
  });

  it("skips registration when already registered (exact path match)", async () => {
    const config = makeGlobalConfig(["ma"]);
    mockLoadGlobalConfig.mockReturnValue(config);
    mockFindProjectByPath.mockReturnValue({ id: "ma", entry: config.projects["ma"] });
    await runCommand(["project", "add", "/home/user/my-app"]);
    expect(mockRegisterProject).not.toHaveBeenCalled();
    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
  });

  it("uses --id override when provided", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    await runCommand(["project", "add", "/home/user/my-app", "--id", "custom"]);
    expect(mockRegisterProject).toHaveBeenCalledWith(
      expect.anything(),
      "custom",
      expect.anything(),
    );
  });

  it("uses --name override when provided", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    await runCommand(["project", "add", "/home/user/my-app", "--name", "My App"]);
    expect(mockRegisterProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ name: "My App" }),
    );
  });

  it("appends numeric suffix when derived ID is taken by a different path", async () => {
    // "my-app" → generateProjectId → "my-app" → generateSessionPrefix → "my" → taken by /other/path
    mockGenerateProjectId.mockReturnValue("my-app");
    mockGenerateSessionPrefix.mockReturnValue("my");
    const config = makeGlobalConfig([]);
    config.projects["my"] = { name: "Other", path: "/other/path" } as GlobalConfig["projects"][string];
    mockLoadGlobalConfig.mockReturnValue(config);
    mockRegisterProject.mockImplementation((cfg: GlobalConfig, id: string, entry: unknown) => ({
      ...cfg,
      projects: { ...cfg.projects, [id]: entry },
    }));

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCommand(["project", "add", "/home/user/my-app"]);
    spy.mockRestore();

    expect(mockRegisterProject).toHaveBeenCalledWith(
      expect.anything(),
      "my2",
      expect.anything(),
    );
  });

  it("syncs shadow for hybrid projects", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig([]));
    mockDetectConfigMode.mockReturnValue("hybrid");
    mockFindLocalConfigPath.mockReturnValue("/home/user/my-app/agent-orchestrator.yaml");
    mockLoadLocalProjectConfig.mockReturnValue({ repo: "org/my-app", defaultBranch: "main" });
    mockSyncShadow.mockReturnValue({ config: makeGlobalConfig(["my"]), excludedSecrets: [] });
    await runCommand(["project", "add", "/home/user/my-app"]);
    expect(mockSyncShadow).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ao project remove
// ---------------------------------------------------------------------------

describe("ao project remove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStopLifecycleWorker.mockResolvedValue(false);
    mockPromptConfirm.mockResolvedValue(true);
    mockIsHumanCaller.mockReturnValue(false);
    mockSessionManager.list.mockResolvedValue([]);
    mockUnregisterProject.mockImplementation((cfg: GlobalConfig, id: string) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      const { [id]: _removed, ...rest } = cfg.projects;
      const updated = { ...cfg, projects: rest };
      return updated;
    });
    mockLoadConfig.mockReturnValue(makeGlobalConfig());
  });

  it("removes a project when found in global config", async () => {
    const globalConfig = makeGlobalConfig(["my-project"]);
    mockLoadGlobalConfig.mockReturnValue(globalConfig);

    await runCommand(["project", "remove", "my-project", "--force"]);

    expect(mockUnregisterProject).toHaveBeenCalledWith(globalConfig, "my-project");
    expect(mockSaveGlobalConfig).toHaveBeenCalled();
    expect(mockDeleteShadowFile).toHaveBeenCalledWith("my-project");
  });

  it("exits with error when global config is not found", async () => {
    mockLoadGlobalConfig.mockReturnValue(null);
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    await expect(runCommand(["project", "remove", "nonexistent", "--force"])).rejects.toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
  });

  it("exits with error when project ID is not in global config", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["other-project"]));
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    await expect(runCommand(["project", "remove", "nonexistent", "--force"])).rejects.toThrow();
    expect(mockExit).toHaveBeenCalledWith(1);

    mockExit.mockRestore();
  });

  it("shows active sessions and includes orphan warning in prompt", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockSessionManager.list.mockResolvedValue([{ id: "my-project-session-1" }, { id: "my-project-session-2" }]);
    mockIsHumanCaller.mockReturnValue(true);
    mockPromptConfirm.mockResolvedValue(true);

    await runCommand(["project", "remove", "my-project"]);

    expect(mockPromptConfirm).toHaveBeenCalledWith(
      expect.stringContaining("active sessions will be orphaned"),
      false,
    );
  });

  it("cancels when user declines confirmation", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockIsHumanCaller.mockReturnValue(true);
    mockPromptConfirm.mockResolvedValue(false);

    await runCommand(["project", "remove", "my-project"]);

    expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
    expect(mockDeleteShadowFile).not.toHaveBeenCalled();
  });

  it("skips confirmation with --force", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockIsHumanCaller.mockReturnValue(true);

    await runCommand(["project", "remove", "my-project", "--force"]);

    expect(mockPromptConfirm).not.toHaveBeenCalled();
    expect(mockSaveGlobalConfig).toHaveBeenCalled();
  });

  it("stops lifecycle worker before removing", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));

    await runCommand(["project", "remove", "my-project", "--force"]);

    expect(mockStopLifecycleWorker).toHaveBeenCalledWith(expect.anything(), "my-project");
  });

  it("proceeds even when stopLifecycleWorker throws", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockStopLifecycleWorker.mockRejectedValue(new Error("worker error"));

    await runCommand(["project", "remove", "my-project", "--force"]);

    expect(mockSaveGlobalConfig).toHaveBeenCalled();
    expect(mockDeleteShadowFile).toHaveBeenCalledWith("my-project");
  });

  it("proceeds when session manager throws", async () => {
    mockLoadGlobalConfig.mockReturnValue(makeGlobalConfig(["my-project"]));
    mockLoadConfig.mockImplementation(() => { throw new Error("no config"); });

    await runCommand(["project", "remove", "my-project", "--force"]);

    expect(mockSaveGlobalConfig).toHaveBeenCalled();
  });
});
