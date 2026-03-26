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
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("$ some terminal output\n"),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  const agent: Agent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn(),
    getEnvironment: vi.fn(),
    detectActivity: vi.fn().mockReturnValue("active" as ActivityState),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  const workspace: Workspace = {
    name: "mock-ws",
    create: vi.fn(),
    destroy: vi.fn(),
  };

  return { runtime, agent, workspace };
}

export function createMockSCM(overrides: Partial<SCM> = {}): SCM {
  return {
    name: "mock-scm",
    detectPR: vi.fn(),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    getCIChecks: vi.fn(),
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getReviews: vi.fn(),
    getReviewDecision: vi.fn().mockResolvedValue("none"),
    getPendingComments: vi.fn(),
    getAutomatedComments: vi.fn(),
    getMergeability: vi.fn(),
    ...overrides,
  };
}

export function createMockNotifier(): Notifier {
  return {
    name: "mock-notifier",
    notify: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

export interface RegistryPlugins {
  runtime: Runtime;
  agent: Agent;
  scm?: SCM;
  notifier?: Notifier;
}

export function createMockRegistry(plugins: RegistryPlugins): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, name?: string) => {
      if (slot === "runtime") return plugins.runtime;
      if (slot === "agent") return plugins.agent;
      if (slot === "scm") return plugins.scm ?? null;
      if (slot === "notifier" && name === "desktop") return plugins.notifier ?? null;
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
// Session manager mock
// ---------------------------------------------------------------------------

export function createMockSessionManager(): SessionManager {
  return {
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    restore: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    claimPR: vi.fn(),
  } as SessionManager;
}
