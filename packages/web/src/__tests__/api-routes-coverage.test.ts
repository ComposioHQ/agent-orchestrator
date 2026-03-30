import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type {
  Session,
  SessionManager,
  OrchestratorConfig,
  PluginRegistry,
  SCM,
  Tracker,
  LifecycleManager,
} from "@composio/ao-core";

// ── Mock Data ─────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

const testSessions: Session[] = [
  makeSession({ id: "backend-3", status: "needs_input", activity: "waiting_input" }),
  makeSession({
    id: "backend-7",
    status: "mergeable",
    activity: "idle",
    pr: {
      number: 432,
      url: "https://github.com/acme/my-app/pull/432",
      title: "feat: health check",
      owner: "acme",
      repo: "my-app",
      branch: "feat/health-check",
      baseBranch: "main",
      isDraft: false,
    },
  }),
  makeSession({ id: "backend-9", status: "working", activity: "active" }),
];

// ── Mock Tracker ──────────────────────────────────────────────────────

const mockTracker: Tracker = {
  name: "github",
  listIssues: vi.fn(async () => [
    {
      id: "ISS-1",
      title: "Fix login bug",
      url: "https://github.com/acme/my-app/issues/1",
      state: "open",
      labels: ["agent:backlog"],
      description: "Login is broken",
    },
    {
      id: "ISS-2",
      title: "Add dark mode",
      url: "https://github.com/acme/my-app/issues/2",
      state: "open",
      labels: [],
      description: "Support dark mode",
    },
  ]),
  createIssue: vi.fn(async (params) => ({
    id: "ISS-NEW",
    title: params.title,
    url: "https://github.com/acme/my-app/issues/99",
    state: "open",
    labels: params.labels ?? [],
    description: params.description ?? "",
  })),
  updateIssue: vi.fn(async () => {}),
};

// ── Mock SCM ──────────────────────────────────────────────────────────

const mockSCM: SCM = {
  name: "github",
  detectPR: vi.fn(async () => null),
  getPRState: vi.fn(async () => "open" as const),
  mergePR: vi.fn(async () => {}),
  closePR: vi.fn(async () => {}),
  getCIChecks: vi.fn(async () => []),
  getCISummary: vi.fn(async () => "passing" as const),
  getReviews: vi.fn(async () => []),
  getReviewDecision: vi.fn(async () => "approved" as const),
  getPendingComments: vi.fn(async () => []),
  getAutomatedComments: vi.fn(async () => []),
  getMergeability: vi.fn(async () => ({
    mergeable: true,
    ciPassing: true,
    approved: true,
    noConflicts: true,
    blockers: [],
  })),
  verifyWebhook: vi.fn(async () => ({ ok: true })),
  parseWebhook: vi.fn(async () => ({
    type: "push" as const,
    action: "completed" as const,
    repository: { owner: "acme", name: "my-app" },
    branch: "feat/health-check",
  })),
};

// ── Mock Lifecycle Manager ────────────────────────────────────────────

const mockLifecycleManager: LifecycleManager = {
  start: vi.fn(),
  stop: vi.fn(),
  getStates: vi.fn(() => new Map()),
  check: vi.fn(async () => {}),
};

// ── Mock Session Manager ──────────────────────────────────────────────

const mockSessionManager: SessionManager = {
  list: vi.fn(async () => testSessions),
  get: vi.fn(async (id: string) => testSessions.find((s) => s.id === id) ?? null),
  spawn: vi.fn(async (config) =>
    makeSession({
      id: `session-${Date.now()}`,
      projectId: config.projectId,
      issueId: config.issueId ?? null,
      status: "spawning",
    }),
  ),
  kill: vi.fn(async () => {}),
  send: vi.fn(async () => {}),
  cleanup: vi.fn(async () => ({ killed: [], skipped: [], errors: [] })),
  spawnOrchestrator: vi.fn(),
  remap: vi.fn(async () => "ses_mock"),
  restore: vi.fn(async () => makeSession({ id: "restored", status: "spawning" })),
};

// ── Mock Registry ─────────────────────────────────────────────────────

const mockRegistry: PluginRegistry = {
  register: vi.fn(),
  get: vi.fn((slot: string) => {
    if (slot === "tracker") return mockTracker;
    if (slot === "scm") return mockSCM;
    return mockSCM;
  }) as PluginRegistry["get"],
  list: vi.fn(() => []),
  loadBuiltins: vi.fn(async () => {}),
  loadFromConfig: vi.fn(async () => {}),
};

// ── Mock Config ───────────────────────────────────────────────────────

const mockConfig: OrchestratorConfig = {
  configPath: "/tmp/ao-test/agent-orchestrator.yaml",
  port: 3000,
  readyThresholdMs: 300_000,
  defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
  projects: {
    "my-app": {
      name: "My App",
      repo: "acme/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "my-app",
      scm: {
        plugin: "github",
        webhook: {
          enabled: true,
          path: "/api/webhooks/github",
          secret: "test-secret",
          maxBodyBytes: 1_000_000,
        },
      },
      tracker: { plugin: "github" },
    },
    "docs-app": {
      name: "Docs App",
      repo: "acme/docs-app",
      path: "/tmp/docs-app",
      defaultBranch: "main",
      sessionPrefix: "docs",
      scm: { plugin: "github" },
    },
  },
  notifiers: {},
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

// ── vi.mock ───────────────────────────────────────────────────────────

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
    lifecycleManager: mockLifecycleManager,
  })),
  getSCM: vi.fn(() => mockSCM),
  getBacklogIssues: vi.fn(async () => [
    {
      id: "ISS-1",
      title: "Fix login bug",
      url: "https://github.com/acme/my-app/issues/1",
      state: "open",
      labels: ["agent:backlog"],
      projectId: "my-app",
      description: "Login is broken",
    },
  ]),
  getVerifyIssues: vi.fn(async () => [
    {
      id: "ISS-V1",
      title: "Verify merged fix",
      url: "https://github.com/acme/my-app/issues/10",
      state: "open",
      labels: ["merged-unverified"],
      projectId: "my-app",
      description: "Merged, needs verification",
    },
  ]),
  startBacklogPoller: vi.fn(),
}));

vi.mock("@/lib/project-name", () => ({
  getAllProjects: vi.fn(() => [
    { id: "my-app", name: "My App" },
    { id: "docs-app", name: "Docs App" },
  ]),
}));

vi.mock("@/lib/serialize", () => ({
  sessionToDashboard: vi.fn((session: Session) => ({
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId,
    pr: session.pr
      ? {
          number: session.pr.number,
          url: session.pr.url,
          title: session.pr.title,
        }
      : null,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
  })),
  resolveProject: vi.fn(
    (session: Session, projects: Record<string, unknown>) => projects[session.projectId],
  ),
  enrichSessionPR: vi.fn(async () => true),
  enrichSessionsMetadata: vi.fn(async () => {}),
}));

vi.mock("@/lib/observability", () => ({
  getCorrelationId: vi.fn(() => "test-correlation-id"),
  jsonWithCorrelation: vi.fn((body: unknown, init: ResponseInit | undefined, _correlationId: string) => {
    const { NextResponse } = require("next/server");
    return NextResponse.json(body, init);
  }),
  recordApiObservation: vi.fn(),
}));

// Mock execFile so promisify(execFile) works correctly.
// Node's real execFile uses [util.promisify.custom], so we set the custom
// promisify symbol on our mock so Node's promisify returns our async mock.
const { mockExecFileAsync, mockExecFile } = vi.hoisted(() => {
  const mockExecFileAsync = vi.fn(async () => ({ stdout: "", stderr: "" }));
  const kCustomPromisified = Symbol.for("nodejs.util.promisify.custom");
  const mockExecFile = vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") (cb as (err: null, s1: string, s2: string) => void)(null, "", "");
  });
  // Make util.promisify(execFile) return our async mock
  (mockExecFile as Record<symbol, unknown>)[kCustomPromisified] = mockExecFileAsync;
  return { mockExecFileAsync, mockExecFile };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: mockExecFile,
  };
});

// We need to mock scm-webhooks for the webhook route tests
vi.mock("@/lib/scm-webhooks", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scm-webhooks")>();
  return {
    ...original,
    findWebhookProjects: vi.fn((...args: Parameters<typeof original.findWebhookProjects>) =>
      original.findWebhookProjects(...args),
    ),
    buildWebhookRequest: vi.fn((...args: Parameters<typeof original.buildWebhookRequest>) =>
      original.buildWebhookRequest(...args),
    ),
    eventMatchesProject: vi.fn((...args: Parameters<typeof original.eventMatchesProject>) =>
      original.eventMatchesProject(...args),
    ),
    findAffectedSessions: vi.fn((...args: Parameters<typeof original.findAffectedSessions>) =>
      original.findAffectedSessions(...args),
    ),
  };
});

// ── Import routes AFTER mocking ───────────────────────────────────────

import { GET as issuesGET, POST as issuesPOST } from "@/app/api/issues/route";
import { GET as verifyGET, POST as verifyPOST } from "@/app/api/verify/route";
import { GET as backlogGET } from "@/app/api/backlog/route";
import { GET as sessionDetailGET } from "@/app/api/sessions/[id]/route";
import { GET as projectsGET } from "@/app/api/projects/route";
import { POST as setupLabelsPOST } from "@/app/api/setup-labels/route";
import { POST as webhooksPOST } from "@/app/api/webhooks/[...slug]/route";
import { getServices, getBacklogIssues, getVerifyIssues, startBacklogPoller } from "@/lib/services";
import { getAllProjects } from "@/lib/project-name";
import { findWebhookProjects } from "@/lib/scm-webhooks";

// ── Helpers ───────────────────────────────────────────────────────────

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

// ── Reset mocks ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Restore execFile async mock
  mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

  // Restore default mock implementations
  (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue(testSessions);
  (mockSessionManager.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (id: string) => testSessions.find((s) => s.id === id) ?? null,
  );
  (mockTracker.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
    {
      id: "ISS-1",
      title: "Fix login bug",
      url: "https://github.com/acme/my-app/issues/1",
      state: "open",
      labels: ["agent:backlog"],
      description: "Login is broken",
    },
    {
      id: "ISS-2",
      title: "Add dark mode",
      url: "https://github.com/acme/my-app/issues/2",
      state: "open",
      labels: [],
      description: "Support dark mode",
    },
  ]);
  (mockTracker.createIssue as ReturnType<typeof vi.fn>).mockImplementation(
    async (params: { title: string; description?: string; labels?: string[] }) => ({
      id: "ISS-NEW",
      title: params.title,
      url: "https://github.com/acme/my-app/issues/99",
      state: "open",
      labels: params.labels ?? [],
      description: params.description ?? "",
    }),
  );
  (mockTracker.updateIssue as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (mockRegistry.get as ReturnType<typeof vi.fn>).mockImplementation((slot: string) => {
    if (slot === "tracker") return mockTracker;
    if (slot === "scm") return mockSCM;
    return mockSCM;
  });
});

// =====================================================================
// Tests
// =====================================================================

describe("API Routes - Coverage", () => {
  // ── GET /api/issues ─────────────────────────────────────────────────
  describe("GET /api/issues", () => {
    it("returns issues from all configured projects", async () => {
      const res = await issuesGET(makeRequest("http://localhost:3000/api/issues"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.issues).toBeDefined();
      expect(Array.isArray(data.issues)).toBe(true);
      // my-app has tracker configured, docs-app does not → only my-app issues
      expect(data.issues.length).toBe(2);
      expect(data.issues[0]).toHaveProperty("projectId", "my-app");
      expect(data.issues[0]).toHaveProperty("id", "ISS-1");
      expect(data.issues[1]).toHaveProperty("id", "ISS-2");
    });

    it("filters by state query param", async () => {
      const res = await issuesGET(makeRequest("http://localhost:3000/api/issues?state=closed"));
      expect(res.status).toBe(200);
      // Verify listIssues was called with the state param
      expect(mockTracker.listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ state: "closed" }),
        expect.anything(),
      );
    });

    it("filters by label query param", async () => {
      const res = await issuesGET(
        makeRequest("http://localhost:3000/api/issues?label=agent:backlog"),
      );
      expect(res.status).toBe(200);
      expect(mockTracker.listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["agent:backlog"] }),
        expect.anything(),
      );
    });

    it("filters by project query param", async () => {
      const res = await issuesGET(
        makeRequest("http://localhost:3000/api/issues?project=my-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.issues).toBeDefined();
      // Only my-app project should be queried
      expect(mockTracker.listIssues).toHaveBeenCalledTimes(1);
    });

    it("skips projects without tracker configured", async () => {
      // docs-app has no tracker, so listIssues should only be called for my-app
      await issuesGET(makeRequest("http://localhost:3000/api/issues"));
      expect(mockTracker.listIssues).toHaveBeenCalledTimes(1);
    });

    it("skips unavailable trackers gracefully", async () => {
      (mockTracker.listIssues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Tracker unavailable"),
      );
      const res = await issuesGET(makeRequest("http://localhost:3000/api/issues"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.issues).toEqual([]);
    });

    it("returns 500 when getServices fails", async () => {
      (getServices as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Config load failed"),
      );
      const res = await issuesGET(makeRequest("http://localhost:3000/api/issues"));
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Config load failed");
    });

    it("filters unknown project to return empty issues", async () => {
      const res = await issuesGET(
        makeRequest("http://localhost:3000/api/issues?project=nonexistent"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.issues).toEqual([]);
      expect(mockTracker.listIssues).not.toHaveBeenCalled();
    });

    it("defaults state to open when no query param", async () => {
      await issuesGET(makeRequest("http://localhost:3000/api/issues"));
      expect(mockTracker.listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ state: "open" }),
        expect.anything(),
      );
    });

    it("skips projects where tracker has no listIssues", async () => {
      (mockRegistry.get as ReturnType<typeof vi.fn>).mockImplementation((slot: string) => {
        if (slot === "tracker") return { name: "minimal-tracker" }; // no listIssues
        return mockSCM;
      });
      const res = await issuesGET(makeRequest("http://localhost:3000/api/issues"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.issues).toEqual([]);
    });
  });

  // ── POST /api/issues ────────────────────────────────────────────────
  describe("POST /api/issues", () => {
    it("creates an issue with valid data", async () => {
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({
            projectId: "my-app",
            title: "New bug report",
            description: "Something is broken",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.issue).toBeDefined();
      expect(data.issue.projectId).toBe("my-app");
      expect(data.issue.id).toBe("ISS-NEW");
      expect(data.issue.title).toBe("New bug report");
    });

    it("creates an issue with addToBacklog flag", async () => {
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({
            projectId: "my-app",
            title: "Backlog item",
            description: "Add to backlog",
            addToBacklog: true,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(201);
      expect(mockTracker.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labels: ["agent:backlog"] }),
        expect.anything(),
      );
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: "not-json",
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid JSON body");
    });

    it("returns 400 when title is missing", async () => {
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({ projectId: "my-app" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("title");
    });

    it("returns 400 when title is too long", async () => {
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({
            projectId: "my-app",
            title: "x".repeat(201),
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("title");
      expect(data.error).toContain("200");
    });

    it("returns 400 when title is empty string", async () => {
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({ projectId: "my-app", title: "   " }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("title");
    });

    it("returns 400 when projectId is missing", async () => {
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({ title: "Some issue" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("projectId is required");
    });

    it("returns 404 for unknown project", async () => {
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({ projectId: "nonexistent", title: "Issue" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("Unknown project");
    });

    it("returns 422 when project has no tracker", async () => {
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({ projectId: "docs-app", title: "Doc issue" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe("No tracker configured for this project");
    });

    it("returns 422 when tracker does not support createIssue", async () => {
      (mockRegistry.get as ReturnType<typeof vi.fn>).mockImplementation((slot: string) => {
        if (slot === "tracker") return { name: "readonly-tracker", listIssues: vi.fn() };
        return mockSCM;
      });
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({ projectId: "my-app", title: "Issue" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toBe("Tracker does not support issue creation");
    });

    it("returns 500 when createIssue throws", async () => {
      (mockTracker.createIssue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("API error"),
      );
      const res = await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({ projectId: "my-app", title: "Failing issue" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("API error");
    });

    it("creates issue without addToBacklog (no labels)", async () => {
      await issuesPOST(
        makeRequest("http://localhost:3000/api/issues", {
          method: "POST",
          body: JSON.stringify({
            projectId: "my-app",
            title: "Regular issue",
            description: "No backlog",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(mockTracker.createIssue).toHaveBeenCalledWith(
        expect.objectContaining({ labels: [] }),
        expect.anything(),
      );
    });
  });

  // ── GET /api/verify ─────────────────────────────────────────────────
  describe("GET /api/verify", () => {
    it("returns merged-unverified issues", async () => {
      const res = await verifyGET();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.issues).toBeDefined();
      expect(Array.isArray(data.issues)).toBe(true);
      expect(data.issues.length).toBe(1);
      expect(data.issues[0].id).toBe("ISS-V1");
      expect(getVerifyIssues).toHaveBeenCalled();
    });

    it("returns 500 when getVerifyIssues fails", async () => {
      (getVerifyIssues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Verify fetch failed"),
      );
      const res = await verifyGET();
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Verify fetch failed");
    });
  });

  // ── POST /api/verify ────────────────────────────────────────────────
  describe("POST /api/verify", () => {
    it("verifies an issue (closes it and adds labels)", async () => {
      const res = await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({
            issueId: "ISS-V1",
            projectId: "my-app",
            action: "verify",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(mockTracker.updateIssue).toHaveBeenCalledWith(
        "ISS-V1",
        expect.objectContaining({
          state: "closed",
          labels: ["verified", "agent:done"],
          removeLabels: ["merged-unverified"],
        }),
        expect.anything(),
      );
    });

    it("verifies an issue with custom comment", async () => {
      await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({
            issueId: "ISS-V1",
            projectId: "my-app",
            action: "verify",
            comment: "Custom verify comment",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(mockTracker.updateIssue).toHaveBeenCalledWith(
        "ISS-V1",
        expect.objectContaining({ comment: "Custom verify comment" }),
        expect.anything(),
      );
    });

    it("fails an issue (adds verification-failed label)", async () => {
      const res = await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({
            issueId: "ISS-V1",
            projectId: "my-app",
            action: "fail",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(mockTracker.updateIssue).toHaveBeenCalledWith(
        "ISS-V1",
        expect.objectContaining({
          labels: ["verification-failed"],
          removeLabels: ["merged-unverified"],
        }),
        expect.anything(),
      );
    });

    it("fails an issue with custom comment", async () => {
      await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({
            issueId: "ISS-V1",
            projectId: "my-app",
            action: "fail",
            comment: "Still broken",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(mockTracker.updateIssue).toHaveBeenCalledWith(
        "ISS-V1",
        expect.objectContaining({ comment: "Still broken" }),
        expect.anything(),
      );
    });

    it("returns 400 when required fields are missing", async () => {
      const res = await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({ issueId: "ISS-V1" }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Missing required fields");
    });

    it("returns 400 when action is invalid", async () => {
      const res = await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({
            issueId: "ISS-V1",
            projectId: "my-app",
            action: "invalid",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('action must be "verify" or "fail"');
    });

    it("returns 404 for unknown project", async () => {
      const res = await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({
            issueId: "ISS-V1",
            projectId: "nonexistent",
            action: "verify",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("Unknown project");
    });

    it("returns 422 when project has no tracker", async () => {
      const res = await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({
            issueId: "ISS-V1",
            projectId: "docs-app",
            action: "verify",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toContain("no tracker");
    });

    it("returns 500 when tracker does not support updateIssue", async () => {
      (mockRegistry.get as ReturnType<typeof vi.fn>).mockImplementation((slot: string) => {
        if (slot === "tracker") return { name: "readonly-tracker", listIssues: vi.fn() };
        return mockSCM;
      });
      const res = await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({
            issueId: "ISS-V1",
            projectId: "my-app",
            action: "verify",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Tracker does not support updateIssue");
    });

    it("returns 500 when updateIssue throws", async () => {
      (mockTracker.updateIssue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Update failed"),
      );
      const res = await verifyPOST(
        makeRequest("http://localhost:3000/api/verify", {
          method: "POST",
          body: JSON.stringify({
            issueId: "ISS-V1",
            projectId: "my-app",
            action: "verify",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Update failed");
    });
  });

  // ── GET /api/backlog ────────────────────────────────────────────────
  describe("GET /api/backlog", () => {
    it("starts poller and returns backlog issues", async () => {
      const res = await backlogGET();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.issues).toBeDefined();
      expect(Array.isArray(data.issues)).toBe(true);
      expect(data.issues.length).toBe(1);
      expect(data.issues[0].id).toBe("ISS-1");
      expect(startBacklogPoller).toHaveBeenCalled();
      expect(getBacklogIssues).toHaveBeenCalled();
    });

    it("returns 500 when getBacklogIssues fails", async () => {
      (getBacklogIssues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Backlog fetch failed"),
      );
      const res = await backlogGET();
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Backlog fetch failed");
    });

    it("starts poller even when getBacklogIssues fails", async () => {
      (getBacklogIssues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Fetch error"),
      );
      await backlogGET();
      expect(startBacklogPoller).toHaveBeenCalled();
    });
  });

  // ── GET /api/sessions/[id] ──────────────────────────────────────────
  describe("GET /api/sessions/[id]", () => {
    it("returns session with enriched data", async () => {
      const req = makeRequest("http://localhost:3000/api/sessions/backend-7");
      const res = await sessionDetailGET(req, { params: Promise.resolve({ id: "backend-7" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("backend-7");
      expect(data.projectId).toBe("my-app");
      expect(data.status).toBe("mergeable");
    });

    it("returns 404 for missing session", async () => {
      const req = makeRequest("http://localhost:3000/api/sessions/nonexistent");
      const res = await sessionDetailGET(req, {
        params: Promise.resolve({ id: "nonexistent" }),
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Session not found");
    });

    it("returns session without PR enrichment when no PR", async () => {
      const req = makeRequest("http://localhost:3000/api/sessions/backend-3");
      const res = await sessionDetailGET(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("backend-3");
      expect(data.status).toBe("needs_input");
    });

    it("returns 500 on unexpected error", async () => {
      (mockSessionManager.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("DB error"),
      );
      // We also need getServices to succeed on the error handler's call
      const req = makeRequest("http://localhost:3000/api/sessions/backend-3");
      const res = await sessionDetailGET(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Internal server error");
    });
  });

  // ── GET /api/projects ───────────────────────────────────────────────
  describe("GET /api/projects", () => {
    it("returns project list", async () => {
      const res = await projectsGET();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.projects).toBeDefined();
      expect(data.projects).toEqual([
        { id: "my-app", name: "My App" },
        { id: "docs-app", name: "Docs App" },
      ]);
      expect(getAllProjects).toHaveBeenCalled();
    });

    it("returns 500 when getAllProjects throws", async () => {
      (getAllProjects as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("Config error");
      });
      const res = await projectsGET();
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Config error");
    });
  });

  // ── POST /api/setup-labels ──────────────────────────────────────────
  describe("POST /api/setup-labels", { timeout: 15_000 }, () => {
    it("creates labels via gh CLI for all configured repos", async () => {
      const res = await setupLabelsPOST();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);
      // my-app + docs-app, 4 labels each = 8 results
      expect(data.results.length).toBe(8);
      // Each result should have repo, label, and status fields
      for (const r of data.results) {
        expect(r).toHaveProperty("repo");
        expect(r).toHaveProperty("label");
        expect(r).toHaveProperty("status");
        expect(["created", "exists"]).toContain(r.status);
      }
    });

    it("handles existing labels gracefully (marks as exists)", async () => {
      // Make execFile reject for every other call to simulate "already exists"
      let callCount = 0;
      mockExecFileAsync.mockImplementation(async () => {
        callCount++;
        if (callCount % 2 === 0) {
          throw new Error("already exists");
        }
        return { stdout: "", stderr: "" };
      });

      const res = await setupLabelsPOST();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toBeDefined();
      // Some should be "exists" due to the alternating error
      const existsResults = data.results.filter(
        (r: { status: string }) => r.status === "exists",
      );
      expect(existsResults.length).toBeGreaterThan(0);
    });

    it("returns 500 when getServices fails", async () => {
      (getServices as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Services failed"),
      );
      const res = await setupLabelsPOST();
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Services failed");
    });

    it("skips projects without repo configured", async () => {
      // Override config to include a project without a repo
      const configWithNoRepo = {
        ...mockConfig,
        projects: {
          ...mockConfig.projects,
          "no-repo": {
            name: "No Repo",
            path: "/tmp/no-repo",
            defaultBranch: "main",
            sessionPrefix: "no-repo",
          },
        },
      };
      (getServices as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        config: configWithNoRepo,
        registry: mockRegistry,
        sessionManager: mockSessionManager,
        lifecycleManager: mockLifecycleManager,
      });

      const res = await setupLabelsPOST();
      expect(res.status).toBe(200);
      const data = await res.json();
      // no-repo project should be skipped, so 8 results from the 2 projects with repos
      expect(data.results.length).toBe(8);
    });
  });

  // ── POST /api/webhooks/[...slug] ────────────────────────────────────
  describe("POST /api/webhooks/[...slug]", () => {
    it("returns 404 when no matching webhook projects", async () => {
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([]);

      const req = new Request("http://localhost:3000/api/webhooks/unknown", {
        method: "POST",
        body: JSON.stringify({ action: "opened" }),
        headers: {
          "content-type": "application/json",
          "content-length": "20",
        },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("No SCM webhook configured for this path");
    });

    it("returns 401 when webhook verification fails", async () => {
      const candidate = {
        projectId: "my-app",
        project: mockConfig.projects["my-app"],
        scm: {
          ...mockSCM,
          verifyWebhook: vi.fn(async () => ({ ok: false, reason: "Bad signature" })),
          parseWebhook: vi.fn(),
        },
      };
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([candidate]);

      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ action: "opened" }),
        headers: {
          "content-type": "application/json",
          "content-length": "20",
        },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Bad signature");
      expect(data.ok).toBe(false);
    });

    it("returns 401 with generic message when verification fails without reason", async () => {
      const candidate = {
        projectId: "my-app",
        project: mockConfig.projects["my-app"],
        scm: {
          ...mockSCM,
          verifyWebhook: vi.fn(async () => ({ ok: false })),
          parseWebhook: vi.fn(),
        },
      };
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([candidate]);

      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ action: "opened" }),
        headers: {
          "content-type": "application/json",
          "content-length": "20",
        },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Webhook verification failed");
    });

    it("returns 413 when payload exceeds maxBodyBytes", async () => {
      const candidate = {
        projectId: "my-app",
        project: {
          ...mockConfig.projects["my-app"],
          scm: {
            plugin: "github",
            webhook: {
              enabled: true,
              path: "/api/webhooks/github",
              secret: "test-secret",
              maxBodyBytes: 10, // very small limit
            },
          },
        },
        scm: mockSCM,
      };
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([candidate]);

      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ action: "opened", data: "x".repeat(100) }),
        headers: {
          "content-type": "application/json",
          "content-length": "200",
        },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(413);
      const data = await res.json();
      expect(data.error).toBe("Webhook payload exceeds configured maxBodyBytes");
    });

    it("returns 202 on successful webhook parse and lifecycle check", async () => {
      const sessionsWithBranch = [
        makeSession({
          id: "backend-7",
          projectId: "my-app",
          status: "working",
          activity: "active",
          branch: "feat/health-check",
          pr: {
            number: 432,
            url: "https://github.com/acme/my-app/pull/432",
            title: "feat: health check",
            owner: "acme",
            repo: "my-app",
            branch: "feat/health-check",
            baseBranch: "main",
            isDraft: false,
          },
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        sessionsWithBranch,
      );

      const candidate = {
        projectId: "my-app",
        project: mockConfig.projects["my-app"],
        scm: {
          ...mockSCM,
          verifyWebhook: vi.fn(async () => ({ ok: true })),
          parseWebhook: vi.fn(async () => ({
            type: "push",
            action: "completed",
            repository: { owner: "acme", name: "my-app" },
            branch: "feat/health-check",
          })),
        },
      };
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([candidate]);

      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ ref: "refs/heads/feat/health-check" }),
        headers: {
          "content-type": "application/json",
          "content-length": "50",
        },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.projectIds).toContain("my-app");
      expect(data.sessionIds).toContain("backend-7");
      expect(data.matchedSessions).toBe(1);
    });

    it("handles parse errors gracefully", async () => {
      const candidate = {
        projectId: "my-app",
        project: mockConfig.projects["my-app"],
        scm: {
          ...mockSCM,
          verifyWebhook: vi.fn(async () => ({ ok: true })),
          parseWebhook: vi.fn(async () => {
            throw new Error("Invalid payload format");
          }),
        },
      };
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([candidate]);

      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ invalid: true }),
        headers: {
          "content-type": "application/json",
          "content-length": "20",
        },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.parseErrors).toContain("Invalid payload format");
    });

    it("returns 500 when getServices fails", async () => {
      (getServices as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Services unavailable"),
      );
      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Services unavailable");
    });

    it("skips events that do not match the project repo", async () => {
      const candidate = {
        projectId: "my-app",
        project: mockConfig.projects["my-app"],
        scm: {
          ...mockSCM,
          verifyWebhook: vi.fn(async () => ({ ok: true })),
          parseWebhook: vi.fn(async () => ({
            type: "push",
            action: "completed",
            repository: { owner: "other-org", name: "other-repo" },
            branch: "main",
          })),
        },
      };
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([candidate]);

      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ action: "push" }),
        headers: {
          "content-type": "application/json",
          "content-length": "20",
        },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.matchedSessions).toBe(0);
    });

    it("handles lifecycle check errors without failing", async () => {
      const sessionsWithBranch = [
        makeSession({
          id: "backend-7",
          projectId: "my-app",
          status: "working",
          activity: "active",
          branch: "feat/health-check",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        sessionsWithBranch,
      );
      (mockLifecycleManager.check as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Lifecycle check failed"),
      );

      const candidate = {
        projectId: "my-app",
        project: mockConfig.projects["my-app"],
        scm: {
          ...mockSCM,
          verifyWebhook: vi.fn(async () => ({ ok: true })),
          parseWebhook: vi.fn(async () => ({
            type: "push",
            action: "completed",
            repository: { owner: "acme", name: "my-app" },
            branch: "feat/health-check",
          })),
        },
      };
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([candidate]);

      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ ref: "refs/heads/feat/health-check" }),
        headers: {
          "content-type": "application/json",
          "content-length": "50",
        },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.lifecycleErrors.length).toBe(1);
      expect(data.lifecycleErrors[0]).toContain("Lifecycle check failed");
    });

    it("does not trigger lifecycle check when no sessions match the event", async () => {
      // Sessions with different branch than webhook event
      const sessionsNoMatch = [
        makeSession({
          id: "backend-9",
          projectId: "my-app",
          status: "working",
          activity: "active",
          branch: "feat/other-branch",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        sessionsNoMatch,
      );

      const candidate = {
        projectId: "my-app",
        project: mockConfig.projects["my-app"],
        scm: {
          ...mockSCM,
          verifyWebhook: vi.fn(async () => ({ ok: true })),
          parseWebhook: vi.fn(async () => ({
            type: "push",
            action: "completed",
            repository: { owner: "acme", name: "my-app" },
            branch: "feat/health-check",
          })),
        },
      };
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([candidate]);

      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ ref: "refs/heads/feat/health-check" }),
        headers: {
          "content-type": "application/json",
          "content-length": "50",
        },
      });
      const res = await webhooksPOST(req);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.matchedSessions).toBe(0);
      expect(mockLifecycleManager.check).not.toHaveBeenCalled();
    });

    it("does not check body size when maxBodyBytes is not configured on any candidate", async () => {
      const candidate = {
        projectId: "my-app",
        project: {
          ...mockConfig.projects["my-app"],
          scm: {
            plugin: "github",
            webhook: {
              enabled: true,
              path: "/api/webhooks/github",
              secret: "test-secret",
              // no maxBodyBytes
            },
          },
        },
        scm: {
          ...mockSCM,
          verifyWebhook: vi.fn(async () => ({ ok: true })),
          parseWebhook: vi.fn(async () => ({
            type: "push",
            action: "completed",
            repository: { owner: "acme", name: "my-app" },
            branch: "main",
          })),
        },
      };
      (findWebhookProjects as ReturnType<typeof vi.fn>).mockReturnValueOnce([candidate]);

      const largeBody = JSON.stringify({ data: "x".repeat(10_000_000) });
      const req = new Request("http://localhost:3000/api/webhooks/github", {
        method: "POST",
        body: largeBody,
        headers: {
          "content-type": "application/json",
          "content-length": String(largeBody.length),
        },
      });
      const res = await webhooksPOST(req);
      // Should not be 413 — size check is skipped when no maxBodyBytes
      expect(res.status).not.toBe(413);
    });
  });
});
