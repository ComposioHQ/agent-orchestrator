import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { validateSession } from "../recovery/validator.js";
import type { ScannedSession } from "../recovery/scanner.js";
import type { Agent, OrchestratorConfig, PluginRegistry, Runtime, Workspace } from "../types.js";
import { getSessionsDir } from "../paths.js";

describe("recovery validator", () => {
  let rootDir = "";

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uses role-specific orchestrator agent fallback when metadata is missing agent", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
    };
    const mockWorkerAgent: Agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockResolvedValue(false),
      getSessionInfo: vi.fn(),
    };
    const mockOrchestratorAgent: Agent = {
      ...mockWorkerAgent,
      name: "codex",
      processName: "codex",
      isProcessRunning: vi.fn().mockResolvedValue(true),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "agent") {
          if (name === "codex") return mockOrchestratorAgent;
          if (name === "mock-agent") return mockWorkerAgent;
        }
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "mock-agent",
        workspace: "worktree",
        notifiers: ["desktop"],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: projectPath,
          defaultBranch: "main",
          sessionPrefix: "app",
          agent: "mock-agent",
          orchestrator: {
            agent: "codex",
          },
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: ["desktop"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
      reactions: {},
    };
    const scanned: ScannedSession = {
      sessionId: "app-orchestrator",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        worktree: projectPath,
        status: "working",
        role: "orchestrator",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);

    expect(assessment.agentProcessRunning).toBe(true);
    expect(mockOrchestratorAgent.isProcessRunning).toHaveBeenCalled();
    expect(mockWorkerAgent.isProcessRunning).not.toHaveBeenCalled();
  });

  it("classifies as 'dead' when runtime is dead and workspace is missing with non-terminal status", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-dead",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: { status: "working" },
    };

    const assessment = await validateSession(scanned, config, registry);
    expect(assessment.classification).toBe("dead");
    expect(assessment.action).toBe("cleanup");
    expect(assessment.reason).toContain("dead");
  });

  it("classifies as 'unrecoverable' when runtime is dead and workspace is missing with terminal status", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-terminal",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: { status: "terminated" },
    };

    const assessment = await validateSession(scanned, config, registry);
    expect(assessment.classification).toBe("unrecoverable");
    expect(assessment.action).toBe("skip");
    expect(assessment.reason).toContain("terminal");
  });

  it("classifies as 'partial' when runtime is alive but workspace is missing (line 133-134)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
    };

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-partial",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        status: "working",
        worktree: "/nonexistent/path/that/does/not/exist",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);
    expect(assessment.classification).toBe("partial");
    expect(assessment.reason).toContain("Incomplete");
  });

  it("classifies as 'live' when runtime, workspace, and agent are all alive", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    const mockAgent: Agent = {
      name: "claude-code",
      processName: "claude-code",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn(),
    };

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-live",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        status: "working",
        worktree: projectPath,
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);
    expect(assessment.classification).toBe("live");
    expect(assessment.action).toBe("recover");
    expect(assessment.reason).toContain("running normally");
  });

  it("classifies as 'partial' when runtime and workspace exist but agent is not running (line 140-142)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    const mockAgent: Agent = {
      name: "claude-code",
      processName: "claude-code",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockResolvedValue(false), // agent not running
      getSessionInfo: vi.fn(),
    };

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "agent") return mockAgent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-partial-agent",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        status: "working",
        worktree: projectPath,
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);
    expect(assessment.classification).toBe("partial");
    expect(assessment.reason).toContain("Incomplete");
  });

  it("determines 'escalate' action for dead sessions when autoCleanup is false (line 157)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-esc",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: { status: "working" },
    };

    const assessment = await validateSession(scanned, config, registry, { autoCleanup: false });
    expect(assessment.classification).toBe("dead");
    expect(assessment.action).toBe("escalate");
  });

  it("determines 'cleanup' action for partial sessions when escalatePartial is false (line 159)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
    };

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-partial-cleanup",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        status: "working",
        worktree: "/nonexistent/path",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry, { escalatePartial: false });
    expect(assessment.classification).toBe("partial");
    expect(assessment.action).toBe("cleanup");
  });

  it("handles runtime.isAlive throwing an error (line 57-59)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn(),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn().mockRejectedValue(new Error("tmux not found")),
    };

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-runtime-err",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        status: "working",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);
    // runtime.isAlive throws => runtimeAlive = false
    expect(assessment.runtimeAlive).toBe(false);
  });

  it("handles agent.isProcessRunning throwing an error (line 84-86)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockAgent: Agent = {
      name: "claude-code",
      processName: "claude-code",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockRejectedValue(new Error("pgrep failed")),
      getSessionInfo: vi.fn(),
    };

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "agent") return mockAgent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-agent-err",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        status: "working",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);
    // agent.isProcessRunning throws => agentProcessRunning = false
    expect(assessment.agentProcessRunning).toBe(false);
  });

  it("checks workspace.exists when existsSync returns false but workspace plugin is available (line 70-76)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(true), // workspace plugin says it exists
    };

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-ws-exists",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        status: "working",
        worktree: "/nonexistent/path/definitely/not/there",
      },
    };

    const assessment = await validateSession(scanned, config, registry);
    // existsSync returns false but workspace.exists returns true
    expect(assessment.workspaceExists).toBe(true);
    expect(mockWorkspace.exists).toHaveBeenCalled();
  });

  it("handles workspace.exists throwing an error (line 73-75)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockRejectedValue(new Error("workspace check failed")),
    };

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-ws-err",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        status: "working",
        worktree: "/nonexistent/path",
      },
    };

    const assessment = await validateSession(scanned, config, registry);
    expect(assessment.workspaceExists).toBe(false);
  });

  it("classifies as 'dead' when runtime is dead but workspace exists (line 137-139)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-dead-ws",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        status: "working",
        worktree: projectPath, // workspace exists (points to a real dir)
      },
    };

    const assessment = await validateSession(scanned, config, registry);
    // Runtime is not alive (no runtime plugin found), workspace exists => dead
    expect(assessment.classification).toBe("dead");
    expect(assessment.runtimeAlive).toBe(false);
    expect(assessment.workspaceExists).toBe(true);
    expect(assessment.reason).toContain("dead");
  });

  it("handles empty metadata as metadataValid = false", async () => {
    rootDir = join(tmpdir(), `ao-recovery-validator-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    const projectPath = join(rootDir, "project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        app: { name: "app", repo: "org/repo", path: projectPath, defaultBranch: "main", sessionPrefix: "app" },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    const scanned: ScannedSession = {
      sessionId: "app-empty-meta",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {},
    };

    const assessment = await validateSession(scanned, config, registry);
    expect(assessment.metadataValid).toBe(false);
  });
});
