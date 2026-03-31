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
      loadExternals: vi.fn().mockResolvedValue(undefined),
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

  it("sets runtimeAlive to false when runtime.isAlive throws an error", async () => {
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
      isAlive: vi.fn().mockRejectedValue(new Error("Runtime check failed")),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
      exists: vi.fn().mockResolvedValue(true),
    };
    const mockAgent: Agent = {
      name: "mock-agent",
      processName: "mock-agent",
      getLaunchCommand: vi.fn(),
      getEnvironment: vi.fn(),
      detectActivity: vi.fn(),
      getActivityState: vi.fn(),
      isProcessRunning: vi.fn().mockResolvedValue(false),
      getSessionInfo: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        if (slot === "agent") return mockAgent;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
      loadExternals: vi.fn().mockResolvedValue(undefined),
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
      sessionId: "app-1",
      projectId: "app",
      project: config.projects.app,
      sessionsDir: getSessionsDir(config.configPath, projectPath),
      rawMetadata: {
        worktree: projectPath,
        status: "working",
        runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      },
    };

    const assessment = await validateSession(scanned, config, registry);

    expect(mockRuntime.isAlive).toHaveBeenCalled();
    expect(assessment.runtimeAlive).toBe(false);
  });
});
