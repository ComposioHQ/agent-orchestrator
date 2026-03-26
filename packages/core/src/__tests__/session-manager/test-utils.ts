import { vi } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getSessionsDir, getProjectBaseDir } from "../../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Workspace,
  RuntimeHandle,
} from "../../types.js";

export function makeHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "mock", data: {} };
}

export interface TestContext {
  tmpDir: string;
  configPath: string;
  sessionsDir: string;
  mockRuntime: Runtime;
  mockAgent: Agent;
  mockWorkspace: Workspace;
  mockRegistry: PluginRegistry;
  config: OrchestratorConfig;
  originalPath: string | undefined;
}

export function createMockPlugins(): {
  mockRuntime: Runtime;
  mockAgent: Agent;
  mockWorkspace: Workspace;
} {
  const mockRuntime: Runtime = {
    name: "mock",
    create: vi.fn().mockResolvedValue(makeHandle("rt-1")),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  const mockAgent: Agent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn().mockReturnValue("mock-agent --start"),
    getEnvironment: vi.fn().mockReturnValue({ AGENT_VAR: "1" }),
    detectActivity: vi.fn().mockReturnValue("active"),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  const mockWorkspace: Workspace = {
    name: "mock-ws",
    create: vi.fn().mockResolvedValue({
      path: "/tmp/mock-ws/app-1",
      branch: "feat/TEST-1",
      sessionId: "app-1",
      projectId: "my-app",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };

  return { mockRuntime, mockAgent, mockWorkspace };
}

export function createMockRegistry(
  mockRuntime: Runtime,
  mockAgent: Agent,
  mockWorkspace: Workspace,
): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, name: string) => {
      if (slot === "runtime" && name === mockRuntime.name) return mockRuntime;
      if (slot === "agent" && name === mockAgent.name) return mockAgent;
      if (slot === "workspace" && name === mockWorkspace.name) return mockWorkspace;
      // Fallback: return the plugin for any name in the slot (backwards compat)
      if (slot === "runtime") return mockRuntime;
      if (slot === "agent") return mockAgent;
      if (slot === "workspace") return mockWorkspace;
      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };
}

export function setupTestContext(): TestContext {
  const originalPath = process.env.PATH;
  const tmpDir = join(tmpdir(), `ao-test-session-mgr-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  const configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  const { mockRuntime, mockAgent, mockWorkspace } = createMockPlugins();
  const mockRegistry = createMockRegistry(mockRuntime, mockAgent, mockWorkspace);

  const config: OrchestratorConfig = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
        tracker: { plugin: "github" },
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
    readyThresholdMs: 300_000,
  };

  const sessionsDir = getSessionsDir(configPath, join(tmpDir, "my-app"));
  mkdirSync(sessionsDir, { recursive: true });

  return {
    tmpDir,
    configPath,
    sessionsDir,
    mockRuntime,
    mockAgent,
    mockWorkspace,
    mockRegistry,
    config,
    originalPath,
  };
}

export function teardownTestContext(ctx: TestContext): void {
  process.env.PATH = ctx.originalPath;
  const projectBaseDir = getProjectBaseDir(ctx.configPath, join(ctx.tmpDir, "my-app"));
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
}
