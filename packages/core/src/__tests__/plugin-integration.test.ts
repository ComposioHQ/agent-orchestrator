/**
 * Plugin integration tests — core services calling real plugin instances.
 *
 * These tests verify the full path: core service → real plugin → mocked external API.
 * Both tracker-github and scm-github use `gh` CLI via `execFile`, so a single
 * `vi.mock("node:child_process")` covers both plugins.
 *
 * Runtime, Agent, and Workspace remain mock objects — we're testing the
 * tracker/SCM integration path, not those.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock node:child_process — must be hoisted before plugin imports
// ---------------------------------------------------------------------------

const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: ghMock,
  });
  return { execFile };
});

// ---------------------------------------------------------------------------
// Imports — plugins resolve the mocked child_process at import time
// ---------------------------------------------------------------------------

import { createPluginRegistry } from "../plugin-registry.js";
import { createSessionManager } from "../session-manager.js";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { writeMetadata } from "../metadata.js";
import { getSessionsDir } from "../paths.js";
import trackerGithub from "@composio/ao-plugin-tracker-github";
import scmGithub from "@composio/ao-plugin-scm-github";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Workspace,
  RuntimeHandle,
  SessionManager,
  PRInfo,
  Session,
} from "../types.js";

// ---------------------------------------------------------------------------
// Shared fixtures + helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let config: OrchestratorConfig;
let project: OrchestratorConfig["projects"][string];

function makeHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "mock", data: {} };
}

function mockGh(result: unknown): void {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

const pr: PRInfo = {
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  title: "feat: add feature",
  owner: "acme",
  repo: "app",
  branch: "feat/issue-99",
  baseBranch: "main",
  isDraft: false,
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/issue-99",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/test-app",
    runtimeHandle: makeHandle("rt-1"),
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  tmpDir = join(tmpdir(), `ao-test-plugin-int-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Create a temporary config file
  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  // Initialize project with tmpDir-based path
  project = {
    name: "Test App",
    repo: "acme/app",
    path: join(tmpDir, "test-app"),
    defaultBranch: "main",
    sessionPrefix: "app",
    tracker: { plugin: "github" },
    scm: { plugin: "github" },
  };

  mockRuntime = {
    name: "mock",
    create: vi.fn().mockResolvedValue(makeHandle("rt-1")),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue(""),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  mockAgent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn().mockReturnValue("mock-agent --start"),
    getEnvironment: vi.fn().mockReturnValue({ AGENT_VAR: "1" }),
    detectActivity: vi.fn().mockResolvedValue("active"),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  mockWorkspace = {
    name: "mock-ws",
    create: vi.fn().mockResolvedValue({
      path: "/tmp/mock-ws/app-1",
      branch: "feat/issue-99",
      sessionId: "app-1",
      projectId: "my-app",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };

  config = {
    configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: [],
    },
    projects: {
      "my-app": project,
    },
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
  };

  // Calculate sessions directory
  sessionsDir = getSessionsDir(configPath, project.path);
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: create a registry with real tracker-github and scm-github
// ---------------------------------------------------------------------------

function createTestRegistry(): PluginRegistry {
  const registry = createPluginRegistry();

  // Register mock plugins for runtime/agent/workspace
  registry.register({
    manifest: { name: "mock", slot: "runtime", description: "mock", version: "0.0.0" },
    create: () => mockRuntime,
  });
  registry.register({
    manifest: { name: "mock-agent", slot: "agent", description: "mock", version: "0.0.0" },
    create: () => mockAgent,
  });
  registry.register({
    manifest: { name: "mock-ws", slot: "workspace", description: "mock", version: "0.0.0" },
    create: () => mockWorkspace,
  });

  // Register REAL plugins
  registry.register(trackerGithub);
  registry.register(scmGithub);

  return registry;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("plugin integration", () => {
  // -------------------------------------------------------------------------
  describe("registry + real plugins", () => {
    it("registers tracker-github and scm-github via real registry", () => {
      const registry = createTestRegistry();

      const trackers = registry.list("tracker");
      const scms = registry.list("scm");

      expect(trackers).toContainEqual(expect.objectContaining({ name: "github", slot: "tracker" }));
      expect(scms).toContainEqual(expect.objectContaining({ name: "github", slot: "scm" }));
    });

    it("registry.get returns correct plugin instances by slot+name", () => {
      const registry = createTestRegistry();

      const tracker = registry.get("tracker", "github");
      const scm = registry.get("scm", "github");

      expect(tracker).not.toBeNull();
      expect(scm).not.toBeNull();
      expect(tracker).toHaveProperty("name", "github");
      expect(scm).toHaveProperty("name", "github");
      // Verify they have the expected methods
      expect(tracker).toHaveProperty("branchName");
      expect(tracker).toHaveProperty("isCompleted");
      expect(scm).toHaveProperty("getPRState");
      expect(scm).toHaveProperty("getCISummary");
    });
  });

  // -------------------------------------------------------------------------
  describe("SessionManager + Tracker", () => {
    it("spawn() uses tracker-github branchName() to derive branch", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      // Mock gh issue view response for validation
      mockGh({
        number: 99,
        title: "Test issue",
        body: "Test description",
        url: "https://github.com/acme/app/issues/99",
        state: "OPEN",
        stateReason: null,
        labels: [],
        assignees: [],
      });

      const session = await sm.spawn({
        projectId: "my-app",
        issueId: "99",
      });

      // tracker-github.branchName("99", project) → "feat/issue-99"
      expect(session.branch).toBe("feat/issue-99");

      // Workspace should have been called with the tracker-derived branch
      expect(mockWorkspace.create).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "feat/issue-99" }),
      );
    });

    it("spawn() falls back to generic branch when no tracker configured", async () => {
      // Remove tracker from project config
      const noTrackerConfig: OrchestratorConfig = {
        ...config,
        projects: {
          "my-app": { ...project, tracker: undefined },
        },
      };
      const registry = createTestRegistry();
      const sm = createSessionManager({ config: noTrackerConfig, registry });

      const session = await sm.spawn({
        projectId: "my-app",
        issueId: "99",
      });

      // Without tracker, falls back to "feat/<issueId>"
      expect(session.branch).toBe("feat/99");
    });

    it("cleanup() calls tracker-github isCompleted() and kills completed sessions", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      // Seed a session with an issueId but no PR
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        issue: "99",
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      // Mock gh: issue is closed
      mockGh({ state: "CLOSED" });

      const result = await sm.cleanup("my-app");

      expect(result.killed).toContain("app-1");
      // Verify the gh CLI was called with the right args
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["issue", "view", "99", "--repo", "acme/app"]),
        expect.any(Object),
      );
    });

    it("cleanup() skips sessions when issue is still open", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        issue: "99",
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      // Mock gh: issue is still open — runtime also alive
      mockGh({ state: "OPEN" });

      const result = await sm.cleanup("my-app");

      expect(result.skipped).toContain("app-1");
      expect(result.killed).not.toContain("app-1");
    });
  });

  // -------------------------------------------------------------------------
  describe("SessionManager + SCM", () => {
    it("cleanup() calls scm-github getPRState() and kills merged PR sessions", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      // metadataToSession extracts PR number from the URL tail (/42),
      // and owner/repo stay empty — scm-github receives exactly that.
      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        pr: pr.url,
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      // Mock gh: PR is merged
      mockGh({ state: "MERGED" });

      const result = await sm.cleanup("my-app");

      expect(result.killed).toContain("app-1");
      // Verify gh CLI was called for PR state check
      expect(ghMock).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["pr", "view", "42"]),
        expect.any(Object),
      );
    });

    it("cleanup() skips sessions when PR is still open", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        pr: pr.url,
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      // Mock gh: PR is still open — runtime also alive
      mockGh({ state: "OPEN" });

      const result = await sm.cleanup("my-app");

      expect(result.skipped).toContain("app-1");
    });
  });

  // -------------------------------------------------------------------------
  describe("LifecycleManager + SCM", () => {
    let registry: PluginRegistry;
    let sm: SessionManager;

    beforeEach(() => {
      registry = createTestRegistry();
      sm = createSessionManager({ config, registry });
    });

    function seedSession(overrides: Partial<Session> = {}): Session {
      const session = makeSession(overrides);

      writeMetadata(sessionsDir, session.id, {
        worktree: session.workspacePath ?? "/tmp/test-app",
        branch: session.branch ?? "feat/issue-99",
        status: session.status,
        project: session.projectId,
        ...(session.pr ? { pr: JSON.stringify(session.pr) } : {}),
        ...(session.issueId ? { issue: session.issueId } : {}),
        runtimeHandle: JSON.stringify(session.runtimeHandle),
      });

      return session;
    }

    it("check() detects ci_failed via scm-github getCISummary()", async () => {
      seedSession({ status: "pr_open", pr });

      // Mock the sessionManager.list() to return our session
      const mockSM: SessionManager = {
        ...sm,
        list: vi.fn().mockResolvedValue([makeSession({ status: "pr_open", pr })]),
        get: vi.fn().mockResolvedValue(makeSession({ status: "pr_open", pr })),
        kill: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        getAttachInfo: vi.fn().mockResolvedValue(null),
        spawnOrchestrator: vi.fn(),
      };

      const lm = createLifecycleManager({
        config,
        registry,
        sessionManager: mockSM,
      });

      // gh calls for determineStatus:
      // 1. getPRState → open
      mockGh({ state: "OPEN" });
      // 2. getCISummary → failing (pr checks returns array of checks with correct field names)
      mockGh([{ name: "lint", state: "FAILURE", link: "", startedAt: "", completedAt: "" }]);

      await lm.check("app-1");

      const states = lm.getStates();
      expect(states.get("app-1")).toBe("ci_failed");
    });

    it("check() detects merged via scm-github getPRState()", async () => {
      seedSession({ status: "pr_open", pr });

      const mockSM: SessionManager = {
        ...sm,
        list: vi.fn().mockResolvedValue([makeSession({ status: "pr_open", pr })]),
        get: vi.fn().mockResolvedValue(makeSession({ status: "pr_open", pr })),
        kill: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        getAttachInfo: vi.fn().mockResolvedValue(null),
        spawnOrchestrator: vi.fn(),
      };

      const lm = createLifecycleManager({
        config,
        registry,
        sessionManager: mockSM,
      });

      // getPRState → merged
      mockGh({ state: "MERGED" });

      await lm.check("app-1");

      const states = lm.getStates();
      expect(states.get("app-1")).toBe("merged");
    });

    it("check() detects changes_requested via scm-github getReviewDecision()", async () => {
      seedSession({ status: "pr_open", pr });

      const mockSM: SessionManager = {
        ...sm,
        list: vi.fn().mockResolvedValue([makeSession({ status: "pr_open", pr })]),
        get: vi.fn().mockResolvedValue(makeSession({ status: "pr_open", pr })),
        kill: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        getAttachInfo: vi.fn().mockResolvedValue(null),
        spawnOrchestrator: vi.fn(),
      };

      const lm = createLifecycleManager({
        config,
        registry,
        sessionManager: mockSM,
      });

      // 1. getPRState → open
      mockGh({ state: "OPEN" });
      // 2. getCISummary → passing (using correct field names: state and link)
      mockGh([{ name: "lint", state: "SUCCESS", link: "", startedAt: "", completedAt: "" }]);
      // 3. getReviewDecision (gh pr view with reviewDecision)
      mockGh({ reviewDecision: "CHANGES_REQUESTED" });

      await lm.check("app-1");

      const states = lm.getStates();
      expect(states.get("app-1")).toBe("changes_requested");
    });
  });
});
