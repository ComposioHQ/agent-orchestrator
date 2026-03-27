import { vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  SessionManager,
  Session,
  Runtime,
  RuntimeHandle,
  Agent,
  Workspace,
  SCM,
  Notifier,
  ActivityState,
  PRInfo,
} from "../types.js";

// ---------------------------------------------------------------------------
// Data factories
// ---------------------------------------------------------------------------

export function makeHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "mock", data: {} };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "spawning",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

export function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/org/repo/pull/42",
    title: "Fix things",
    owner: "org",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock plugin factories
// ---------------------------------------------------------------------------

export interface MockPlugins {
  runtime: Runtime;
  agent: Agent;
  workspace: Workspace;
}

export function createMockPlugins(): MockPlugins {
  const runtime: Runtime = {
    name: "mock",
    create: vi.fn().mockResolvedValue({ id: "rt-1", runtimeName: "mock", data: {} }),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("$ some terminal output\n"),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  const agent: Agent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn().mockReturnValue("mock-agent --start"),
    getEnvironment: vi.fn().mockReturnValue({ AGENT_VAR: "1" }),
    detectActivity: vi.fn().mockReturnValue("active" as ActivityState),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  const workspace: Workspace = {
    name: "mock-ws",
    create: vi.fn().mockResolvedValue({
      path: "/tmp/ws",
      branch: "feat/test",
      sessionId: "app-1",
      projectId: "my-app",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };

  return { runtime, agent, workspace };
}

export function createMockSCM(overrides: Partial<SCM> = {}): SCM {
  return {
    name: "github",
    detectPR: vi.fn().mockResolvedValue(null),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn().mockResolvedValue(undefined),
    closePR: vi.fn().mockResolvedValue(undefined),
    getCIChecks: vi.fn().mockResolvedValue([]),
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getReviews: vi.fn().mockResolvedValue([]),
    getReviewDecision: vi.fn().mockResolvedValue("none"),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn().mockResolvedValue({
      mergeable: false,
      ciPassing: true,
      approved: false,
      noConflicts: true,
      blockers: [],
    }),
    ...overrides,
  };
}

export function createMockNotifier(): Notifier {
  return {
    name: "desktop",
    notify: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

export interface RegistryPlugins {
  runtime: Runtime;
  agent: Agent;
  workspace?: Workspace;
  scm?: SCM;
  notifier?: Notifier;
}

export function createMockRegistry(plugins: RegistryPlugins): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, name?: string) => {
      // Check for exact name match first
      if (slot === "runtime") {
        if (!name || name === plugins.runtime.name) return plugins.runtime;
      }
      if (slot === "agent") {
        if (!name || name === plugins.agent.name) return plugins.agent;
      }
      if (slot === "workspace" && plugins.workspace) {
        if (!name || name === plugins.workspace.name) return plugins.workspace;
      }
      if (slot === "scm" && plugins.scm) {
        if (!name || name === plugins.scm.name) return plugins.scm;
      }
      if (slot === "notifier" && plugins.notifier) {
        if (!name || name === plugins.notifier.name) return plugins.notifier;
      }

      // Fallback: return the plugin for any name in the slot (backwards compat)
      if (slot === "runtime") return plugins.runtime;
      if (slot === "agent") return plugins.agent;
      if (slot === "workspace") return plugins.workspace ?? null;
      if (slot === "scm") return plugins.scm ?? null;
      if (slot === "notifier") return plugins.notifier ?? null;

      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

export interface TestEnvironment {
  tmpDir: string;
  configPath: string;
  sessionsDir: string;
  config: OrchestratorConfig;
  cleanup: () => void;
}

export function createTestEnvironment(): TestEnvironment {
  const tmpDir = join(tmpdir(), `ao-test-lifecycle-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  const configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

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

  const cleanup = () => {
    const projectBaseDir = getProjectBaseDir(configPath, join(tmpDir, "my-app"));
    if (existsSync(projectBaseDir)) {
      rmSync(projectBaseDir, { recursive: true, force: true });
    }
    rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, configPath, sessionsDir, config, cleanup };
}

// ---------------------------------------------------------------------------
// Test context (for session-manager tests)
// ---------------------------------------------------------------------------

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

export function setupTestContext(): TestContext {
  const originalPath = process.env.PATH;
  const tmpDir = join(tmpdir(), `ao-test-session-mgr-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  const configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  const { runtime: mockRuntime, agent: mockAgent, workspace: mockWorkspace } = createMockPlugins();
  const mockRegistry = createMockRegistry({ runtime: mockRuntime, agent: mockAgent, workspace: mockWorkspace });

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

// ---------------------------------------------------------------------------
// Session manager mock
// ---------------------------------------------------------------------------

export function createMockSessionManager(): SessionManager {
  return {
    spawn: vi.fn().mockResolvedValue(makeSession()),
    spawnOrchestrator: vi.fn().mockResolvedValue(
      makeSession({ id: "app-orchestrator", metadata: { role: "orchestrator" } }),
    ),
    restore: vi.fn().mockResolvedValue(makeSession()),
    createSubSession: vi.fn(),
    listSubSessions: vi.fn().mockResolvedValue([]),
    killSubSession: vi.fn().mockResolvedValue(undefined),
    restoreTerminalSubSession: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue({ killed: [], skipped: [], errors: [] }),
    send: vi.fn().mockResolvedValue(undefined),
    claimPR: vi.fn().mockResolvedValue({
      sessionId: "app-1",
      projectId: "my-app",
      pr: makePR(),
      branchChanged: false,
      githubAssigned: true,
      takenOverFrom: [],
    }),
  } as SessionManager;
}
