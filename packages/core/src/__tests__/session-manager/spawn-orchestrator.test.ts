import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import { validateConfig } from "../../config.js";
import {
  writeMetadata,
  readMetadata,
  readMetadataRaw,
  deleteMetadata,
  reserveSessionId,
  updateMetadata,
} from "../../metadata.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Workspace,
  RuntimeHandle,
} from "../../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "./test-utils.js";
import { installMockOpencode } from "./opencode-helpers.js";

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
  ({ tmpDir, sessionsDir, mockRuntime, mockAgent, mockWorkspace, mockRegistry, config, originalPath } = ctx);
});

afterEach(() => {
  teardownTestContext(ctx);
});

describe("spawnOrchestrator", () => {
  it("blocks orchestrator spawn while the project is globally paused", async () => {
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-orchestrator")),
    });
    updateMetadata(sessionsDir, "app-orchestrator", {
      globalPauseUntil: new Date(Date.now() + 60_000).toISOString(),
      globalPauseReason: "Rate limit reached",
      globalPauseSource: "app-9",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });

    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
      "Project is paused due to model rate limit until",
    );
    expect(mockRuntime.create).not.toHaveBeenCalled();
  });

  it("creates orchestrator session with correct ID", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.id).toBe("app-orchestrator");
    expect(session.status).toBe("working");
    expect(session.projectId).toBe("my-app");
    expect(session.branch).toBe("main");
    expect(session.issueId).toBeNull();
    expect(session.workspacePath).toBe(join(tmpDir, "my-app"));
  });

  it("writes metadata with proper fields", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    const meta = readMetadata(sessionsDir, "app-orchestrator");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("working");
    expect(meta!.project).toBe("my-app");
    expect(meta!.worktree).toBe(join(tmpDir, "my-app"));
    expect(meta!.branch).toBe("main");
    expect(meta!.tmuxName).toBeDefined();
    expect(meta!.runtimeHandle).toBeDefined();
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

  it("discovers and persists OpenCode session id by title when strategy is reuse", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator-reuse-discovery.log");
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

    const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
    expect(meta?.["opencodeSessionId"]).toBe("ses_discovered_orchestrator");
  });

  it("reuses an existing orchestrator session when strategy is reuse", async () => {
    const listLogPath = join(tmpDir, "opencode-list-orchestrator-reuse.log");
    const mockBin = join(tmpDir, "mock-bin-reuse-no-list");
    mkdirSync(mockBin, { recursive: true });
    const scriptPath = join(mockBin, "opencode");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$1" == "session" && "$2" == "list" ]]; then',
        `  printf '%s\\n' "$*" >> '${listLogPath.replace(/'/g, "'\\''")}'`,
        "  printf '[]\\n'",
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(scriptPath, 0o755);
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

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      opencodeSessionId: "ses_existing",
      createdAt: new Date().toISOString(),
    });

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.id).toBe("app-orchestrator");
    expect(session.metadata["orchestratorSessionReused"]).toBe("true");
    expect(mockRuntime.create).not.toHaveBeenCalled();
    expect(mockRuntime.destroy).not.toHaveBeenCalled();
    expect(existsSync(listLogPath)).toBe(false);
  });

  it("destroys orphaned runtime when reuse strategy finds alive runtime but get returns null", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-orphaned-runtime.log");
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

    const orphanedHandle = makeHandle("rt-orphaned");
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(orphanedHandle),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockImplementation(async (handle: RuntimeHandle) => {
      if (handle?.id === "rt-orphaned") {
        deleteMetadata(sessionsDir, "app-orchestrator");
        return true;
      }
      return false;
    });

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.id).toBe("app-orchestrator");
    expect(mockRuntime.destroy).toHaveBeenCalledWith(orphanedHandle);
    expect(mockRuntime.create).toHaveBeenCalled();
  });

  it("reuses mapped OpenCode session id when strategy is reuse and runtime is restarted", async () => {
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

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      opencodeSessionId: "ses_existing",
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_existing" }),
        }),
      }),
    );
    const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
    expect(meta?.["opencodeSessionId"]).toBe("ses_existing");
  });

  it("reuses archived OpenCode mapping for orchestrator when active metadata has no mapping", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator-reuse-archived.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        null,
        { id: "ses_existing", title: "AO:app-orchestrator", updated: 1_772_777_000_000 },
      ]),
      deleteLogPath,
    );
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

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      opencodeSessionId: "ses_existing",
      createdAt: new Date().toISOString(),
    });
    deleteMetadata(sessionsDir, "app-orchestrator", true);
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_existing" }),
        }),
      }),
    );
  });

  it("reuses OpenCode session by title when orchestrator mapping is missing", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-orchestrator-reuse-title.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        null,
        { id: "ses_title_match", title: "AO:app-orchestrator", updated: 1_772_777_000_000 },
      ]),
      deleteLogPath,
    );
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

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(opencodeAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ opencodeSessionId: "ses_title_match" }),
        }),
      }),
    );
    const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
    expect(meta?.["opencodeSessionId"]).toBe("ses_title_match");
  });

  it("starts fresh without deleting prior OpenCode sessions when strategy is ignore", async () => {
    const deleteLogPath = join(tmpDir, "opencode-delete-ignore.log");
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([
        { id: "ses_old", title: "AO:app-orchestrator", updated: "2025-01-01T00:00:00.000Z" },
      ]),
      deleteLogPath,
    );
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

    const configWithIgnoreNew: OrchestratorConfig = {
      ...config,
      defaults: { ...config.defaults, agent: "opencode" },
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "opencode",
          orchestratorSessionStrategy: "ignore",
        },
      },
    };

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValueOnce(true);

    const sm = createSessionManager({
      config: configWithIgnoreNew,
      registry: registryWithOpenCode,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockRuntime.destroy).toHaveBeenCalledWith(makeHandle("rt-existing"));
    expect(mockRuntime.create).toHaveBeenCalled();
    expect(existsSync(deleteLogPath)).toBe(false);
  });

  it("skips workspace creation", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockWorkspace.create).not.toHaveBeenCalled();
  });

  it("calls agent.setupWorkspaceHooks on project path", async () => {
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
      join(tmpDir, "my-app"),
      expect.objectContaining({ dataDir: sessionsDir }),
    );
  });

  it("calls runtime.create with proper config", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: join(tmpDir, "my-app"),
        launchCommand: "mock-agent --start",
      }),
    );
  });

  it("does not persist orchestratorSessionReused metadata on newly created sessions", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawnOrchestrator({ projectId: "my-app" });

    const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
    expect(meta?.["orchestratorSessionReused"]).toBeUndefined();
  });

  it("respawns the orchestrator when stale metadata exists but the runtime is dead", async () => {
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      project: "my-app",
      role: "orchestrator",
      runtimeHandle: JSON.stringify(makeHandle("rt-stale")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockRuntime.create).toHaveBeenCalledTimes(1);
    const meta = readMetadataRaw(sessionsDir, "app-orchestrator");
    expect(meta?.["runtimeHandle"]).toBe(JSON.stringify(makeHandle("rt-1")));
  });

  it("uses orchestratorModel when configured", async () => {
    const configWithOrchestratorModel: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agentConfig: {
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
      expect.objectContaining({ model: "orchestrator-model" }),
    );
  });

  it("keeps orchestrator launch permissionless even when shared config sets permissions", async () => {
    const configWithSharedPermissions: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agentConfig: {
            permissions: "suggest",
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithSharedPermissions,
      registry: mockRegistry,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: "permissionless",
        projectConfig: expect.objectContaining({
          agentConfig: expect.objectContaining({ permissions: "permissionless" }),
        }),
      }),
    );
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
          orchestrator: {
            agent: "codex",
          },
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
        orchestrator: {
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
      config: configWithDefaultOrchestratorAgent,
      registry: registryWithMultipleAgents,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockCodexAgent.getLaunchCommand).toHaveBeenCalled();
    expect(readMetadataRaw(sessionsDir, "app-orchestrator")?.["agent"]).toBe("codex");
  });

  it("keeps shared worker permissions when role-specific config only overrides model", async () => {
    const configWithSharedPermissions: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agentConfig: {
            permissions: "suggest",
          },
          worker: {
            agentConfig: {
              model: "worker-model",
            },
          },
        },
      },
    };

    const validatedConfig = validateConfig(configWithSharedPermissions);
    validatedConfig.configPath = config.configPath;
    const sm = createSessionManager({
      config: validatedConfig,
      registry: mockRegistry,
    });
    await sm.spawn({ projectId: "my-app" });

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: "suggest", model: "worker-model" }),
    );
  });

  it("uses role-specific orchestratorModel when configured", async () => {
    const configWithRoleOrchestratorModel: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agentConfig: {
            model: "worker-model",
            orchestratorModel: "shared-orchestrator-model",
          },
          orchestrator: {
            agentConfig: {
              orchestratorModel: "role-orchestrator-model",
            },
          },
        },
      },
    };

    const sm = createSessionManager({
      config: configWithRoleOrchestratorModel,
      registry: mockRegistry,
    });
    await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ model: "role-orchestrator-model" }),
    );
  });

  it("forwards configured subagent to orchestrator launch", async () => {
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

    // Should pass systemPromptFile (not inline systemPrompt) to avoid tmux truncation
    expect(mockAgent.getLaunchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "app-orchestrator",
        systemPromptFile: expect.stringContaining("orchestrator-prompt.md"),
      }),
    );

    // Verify the file was actually written
    const callArgs = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0][0];
    const promptFile = callArgs.systemPromptFile!;
    expect(existsSync(promptFile)).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(promptFile, "utf-8")).toBe("You are the orchestrator.");
  });

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

  it("reuses existing orchestrator on reservation conflict when strategy is reuse", async () => {
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

    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-concurrent")),
      opencodeSessionId: "ses_concurrent",
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);

    const sm = createSessionManager({ config: configWithReuse, registry: registryWithOpenCode });
    const session = await sm.spawnOrchestrator({ projectId: "my-app" });

    expect(session.metadata["orchestratorSessionReused"]).toBe("true");
    expect(mockRuntime.create).not.toHaveBeenCalled();
  });

  it("recovers reservation conflict when existing session is not usable", async () => {
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "killed",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-dead")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).resolves.toBeDefined();
    expect(mockRuntime.create).toHaveBeenCalledTimes(1);
  });

  it("creates only one runtime on reservation conflict", async () => {
    writeMetadata(sessionsDir, "app-orchestrator", {
      worktree: join(tmpDir, "my-app"),
      branch: "main",
      status: "working",
      role: "orchestrator",
      project: "my-app",
      runtimeHandle: JSON.stringify(makeHandle("rt-existing")),
      createdAt: new Date().toISOString(),
    });

    vi.mocked(mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).resolves.toBeDefined();
    expect(mockRuntime.create).toHaveBeenCalledTimes(1);
  });

  it("does not delete an in-progress reservation file without runtime metadata", async () => {
    expect(reserveSessionId(sessionsDir, "app-orchestrator")).toBe(true);

    const sm = createSessionManager({ config, registry: mockRegistry });

    await expect(sm.spawnOrchestrator({ projectId: "my-app" })).rejects.toThrow(
      "already exists but is not in a reusable state",
    );
    expect(mockRuntime.create).not.toHaveBeenCalled();
    expect(readMetadataRaw(sessionsDir, "app-orchestrator")).toEqual({});
  });
});
