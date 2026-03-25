import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  SessionNotFoundError,
  SessionNotRestorableError,
  type LifecycleManager,
  type SCMWebhookEvent,
  type Session,
  type SessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SCM,
} from "@composio/ao-core";
import * as serialize from "@/lib/serialize";
import { getServices, getSCM } from "@/lib/services";
import { getCachedConfig } from "@/lib/config-cache";

// ── Mock Data ─────────────────────────────────────────────────────────
// Provides test sessions covering the key states the dashboard needs.

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
  makeSession({
    id: "frontend-1",
    status: "killed",
    activity: "exited",
    projectId: "my-app",
    issueId: "INT-1270",
    branch: "feat/INT-1270-table",
  }),
];

const multiProjectSessions: Session[] = [
  makeSession({
    id: "app-orchestrator",
    projectId: "my-app",
    metadata: { role: "orchestrator" },
  }),
  makeSession({
    id: "backend-3",
    projectId: "my-app",
    status: "working",
    activity: "active",
  }),
  makeSession({
    id: "docs-orchestrator",
    projectId: "docs-app",
    metadata: { role: "orchestrator" },
  }),
  makeSession({
    id: "docs-2",
    projectId: "docs-app",
    status: "review_pending",
    activity: "idle",
  }),
];

// ── Mock Services ─────────────────────────────────────────────────────

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
  kill: vi.fn(async (id: string) => {
    if (!testSessions.find((s) => s.id === id)) {
      throw new SessionNotFoundError(id);
    }
  }),
  send: vi.fn(async (id: string) => {
    if (!testSessions.find((s) => s.id === id)) {
      throw new SessionNotFoundError(id);
    }
  }),
  cleanup: vi.fn(async () => ({ killed: [], skipped: [], errors: [] })),
  spawnOrchestrator: vi.fn(),
  remap: vi.fn(async () => "ses_mock"),
  restore: vi.fn(async (id: string) => {
    const session = testSessions.find((s) => s.id === id);
    if (!session) {
      throw new SessionNotFoundError(id);
    }
    // Simulate SessionNotRestorableError for non-terminal sessions
    if (session.status === "working" && session.activity !== "exited") {
      throw new SessionNotRestorableError(id, "session is not in a terminal state");
    }
    return { ...session, status: "spawning" as const, activity: "active" as const };
  }),
};

const mockLifecycleManager: LifecycleManager = {
  start: vi.fn(),
  stop: vi.fn(),
  getStates: vi.fn(() => new Map()),
  check: vi.fn(async () => undefined),
};

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
};

const mockRegistry: PluginRegistry = {
  register: vi.fn(),
  get: vi.fn(() => mockSCM) as PluginRegistry["get"],
  list: vi.fn(() => []),
  loadBuiltins: vi.fn(async () => {}),
  loadFromConfig: vi.fn(async () => {}),
};

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
      scm: { plugin: "github" },
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
  api: {
    token: "secret-token",
  },
};

vi.mock("@/lib/config-cache", () => ({
  getCachedConfig: vi.fn(() => mockConfig),
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
    lifecycleManager: mockLifecycleManager,
  })),
  getSCM: vi.fn(() => mockSCM),
}));

// ── Import routes after mocking ───────────────────────────────────────

import { GET as sessionsGET } from "@/app/api/sessions/route";
import { GET as sessionGET } from "@/app/api/sessions/[id]/route";
import { POST as orchestratorsPOST } from "@/app/api/orchestrators/route";
import { POST as spawnPOST } from "@/app/api/spawn/route";
import { POST as sendPOST } from "@/app/api/sessions/[id]/send/route";
import { POST as messagePOST } from "@/app/api/sessions/[id]/message/route";
import { POST as killPOST } from "@/app/api/sessions/[id]/kill/route";
import { POST as restorePOST } from "@/app/api/sessions/[id]/restore/route";
import { POST as remapPOST } from "@/app/api/sessions/[id]/remap/route";
import { POST as mergePOST } from "@/app/api/prs/[id]/merge/route";
import { POST as webhooksPOST } from "@/app/api/webhooks/[...slug]/route";
import { GET as eventsGET } from "@/app/api/events/route";
import { GET as observabilityGET } from "@/app/api/observability/route";

function makeRawRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

function makeRequest(url: string, init?: RequestInit): NextRequest {
  const headers = new Headers(init?.headers);
  const token = mockConfig.api?.token?.trim();
  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return makeRawRequest(url, { ...init, headers });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockConfig.api = { token: "secret-token" };

  vi.mocked(getServices).mockReset();
  vi.mocked(getSCM).mockReset();
  vi.mocked(getCachedConfig).mockReset();

  (mockRegistry.get as ReturnType<typeof vi.fn>).mockReset();
  (mockRegistry.get as ReturnType<typeof vi.fn>).mockImplementation(() => mockSCM);

  (mockSessionManager.list as ReturnType<typeof vi.fn>).mockReset();
  (mockSessionManager.get as ReturnType<typeof vi.fn>).mockReset();
  (mockSessionManager.spawn as ReturnType<typeof vi.fn>).mockReset();
  (mockSessionManager.kill as ReturnType<typeof vi.fn>).mockReset();
  (mockSessionManager.send as ReturnType<typeof vi.fn>).mockReset();
  (mockSessionManager.cleanup as ReturnType<typeof vi.fn>).mockReset();
  (mockSessionManager.spawnOrchestrator as ReturnType<typeof vi.fn>).mockReset();
  (mockSessionManager.remap as ReturnType<typeof vi.fn>).mockReset();
  (mockSessionManager.restore as ReturnType<typeof vi.fn>).mockReset();

  (mockSCM.detectPR as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.getPRState as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.mergePR as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.closePR as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.getCIChecks as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.getCISummary as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.getReviews as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.getReviewDecision as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.getPendingComments as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.getAutomatedComments as ReturnType<typeof vi.fn>).mockReset();
  (mockSCM.getMergeability as ReturnType<typeof vi.fn>).mockReset();

  vi.mocked(getCachedConfig).mockReturnValue(mockConfig);
  vi.mocked(getServices).mockResolvedValue({
    config: mockConfig,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
    lifecycleManager: mockLifecycleManager,
  });
  vi.mocked(getSCM).mockReturnValue(mockSCM);

  (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue(testSessions);
  (mockSessionManager.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (id: string) => testSessions.find((s) => s.id === id) ?? null,
  );
  (mockSessionManager.spawn as ReturnType<typeof vi.fn>).mockImplementation(async (config) =>
    makeSession({
      id: `session-${Date.now()}`,
      projectId: config.projectId,
      issueId: config.issueId ?? null,
      status: "spawning",
    }),
  );
  (mockSessionManager.kill as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
    if (!testSessions.find((s) => s.id === id)) {
      throw new SessionNotFoundError(id);
    }
  });
  (mockSessionManager.send as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
    if (!testSessions.find((s) => s.id === id)) {
      throw new SessionNotFoundError(id);
    }
  });
  (mockSessionManager.cleanup as ReturnType<typeof vi.fn>).mockResolvedValue({
    killed: [],
    skipped: [],
    errors: [],
  });
  (mockSessionManager.spawnOrchestrator as ReturnType<typeof vi.fn>).mockResolvedValue(
    makeSession({
      id: "my-app-orchestrator",
      projectId: "my-app",
      metadata: { role: "orchestrator" },
    }),
  );
  (mockSessionManager.remap as ReturnType<typeof vi.fn>).mockResolvedValue("ses_mock");
  (mockSessionManager.restore as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
    const session = testSessions.find((s) => s.id === id);
    if (!session) {
      throw new SessionNotFoundError(id);
    }
    if (session.status === "working" && session.activity !== "exited") {
      throw new SessionNotRestorableError(id, "session is not in a terminal state");
    }
    return { ...session, status: "spawning" as const, activity: "active" as const };
  });

  (mockSCM.detectPR as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  (mockSCM.getPRState as ReturnType<typeof vi.fn>).mockResolvedValue("open" as const);
  (mockSCM.mergePR as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (mockSCM.closePR as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (mockSCM.getCIChecks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockSCM.getCISummary as ReturnType<typeof vi.fn>).mockResolvedValue("passing" as const);
  (mockSCM.getReviews as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockSCM.getReviewDecision as ReturnType<typeof vi.fn>).mockResolvedValue("approved" as const);
  (mockSCM.getPendingComments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockSCM.getAutomatedComments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (mockSCM.getMergeability as ReturnType<typeof vi.fn>).mockResolvedValue({
    mergeable: true,
    ciPassing: true,
    approved: true,
    noConflicts: true,
    blockers: [],
  });
  (mockLifecycleManager.check as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  mockConfig.projects["my-app"] = {
    ...mockConfig.projects["my-app"],
    scm: { plugin: "github" },
  };
  (mockSCM.verifyWebhook as ReturnType<typeof vi.fn> | undefined)?.mockReset?.();
  (mockSCM.parseWebhook as ReturnType<typeof vi.fn> | undefined)?.mockReset?.();
});

describe("API Routes", () => {
  // ── GET /api/sessions ──────────────────────────────────────────────

  describe("GET /api/sessions", () => {
    it("rejects unauthorized requests before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions", {
          headers: { authorization: "Bearer wrong-token" },
        }),
      );

      expect(res.status).toBe(401);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      expect(getServices).not.toHaveBeenCalled();
    });

    it("returns sessions array and stats", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessions).toBeDefined();
      expect(Array.isArray(data.sessions)).toBe(true);
      expect(data.sessions.length).toBe(testSessions.length);
      expect(data.stats).toBeDefined();
      expect(data.stats.totalSessions).toBe(data.sessions.length);
    });

    it("stats include expected fields", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      const data = await res.json();
      expect(data.stats).toHaveProperty("totalSessions");
      expect(data.stats).toHaveProperty("workingSessions");
      expect(data.stats).toHaveProperty("openPRs");
      expect(data.stats).toHaveProperty("needsReview");
    });

    it("sessions have expected shape", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      const data = await res.json();
      const session = data.sessions[0];
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("projectId");
      expect(session).toHaveProperty("status");
      expect(session).toHaveProperty("activity");
      expect(session).toHaveProperty("createdAt");
      expect(session).toHaveProperty("notificationState");
    });

    it("skips PR enrichment when metadata enrichment hits timeout", async () => {
      vi.useFakeTimers();

      const metadataSpy = vi
        .spyOn(serialize, "enrichSessionsMetadata")
        .mockImplementation(() => new Promise<void>(() => {}));

      const responsePromise = sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      await vi.advanceTimersByTimeAsync(3_000);
      const res = await responsePromise;

      expect(res.status).toBe(200);
      expect(getSCM).not.toHaveBeenCalled();

      metadataSpy.mockRestore();
      vi.useRealTimers();
    });

    it("returns per-project orchestrators and excludes them from worker sessions", async () => {
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        multiProjectSessions,
      );

      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.orchestratorId).toBeNull();
      expect(data.orchestrators).toEqual([
        { id: "docs-orchestrator", projectId: "docs-app", projectName: "Docs App" },
        { id: "app-orchestrator", projectId: "my-app", projectName: "My App" },
      ]);
      expect(data.sessions.map((session: { id: string }) => session.id)).toEqual([
        "backend-3",
        "docs-2",
      ]);
      expect(data.stats.totalSessions).toBe(2);
    });

    it("supports project-scoped session queries for orchestrator detail views", async () => {
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (projectId?: string) =>
          multiProjectSessions.filter((session) => !projectId || session.projectId === projectId),
      );

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=docs-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.orchestratorId).toBe("docs-orchestrator");
      expect(data.orchestrators).toEqual([
        { id: "docs-orchestrator", projectId: "docs-app", projectName: "Docs App" },
      ]);
      expect(data.sessions.map((session: { id: string }) => session.id)).toEqual(["docs-2"]);
      expect(mockSessionManager.list).toHaveBeenCalledWith("docs-app");
    });

    it("normalizes fallback projectId in list responses", async () => {
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        makeSession({
          id: "docs-9",
          projectId: "missing-project",
          status: "working",
          activity: "active",
        }),
      ]);

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=docs-app"),
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        sessions: [expect.objectContaining({ id: "docs-9", projectId: "docs-app" })],
      });
    });

    it("keeps global pause sourced from all projects even for project-scoped requests", async () => {
      const pausedUntil = new Date(Date.now() + 60_000).toISOString();
      const pausedSessions = [
        makeSession({
          id: "docs-orchestrator",
          projectId: "docs-app",
          metadata: {
            role: "orchestrator",
            globalPauseUntil: pausedUntil,
            globalPauseReason: "Rate limit hit",
            globalPauseSource: "docs-orchestrator",
          },
        }),
        makeSession({ id: "docs-1", projectId: "docs-app", status: "working", activity: "active" }),
        makeSession({
          id: "backend-3",
          projectId: "my-app",
          status: "working",
          activity: "active",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockImplementation(
        async (projectId?: string) =>
          projectId
            ? pausedSessions.filter((session) => session.projectId === projectId)
            : pausedSessions,
      );

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=my-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.globalPause).toMatchObject({
        pausedUntil,
        reason: "Rate limit hit",
        sourceSessionId: "docs-orchestrator",
      });
      expect(mockSessionManager.list).toHaveBeenNthCalledWith(1, "my-app");
      expect(mockSessionManager.list).toHaveBeenNthCalledWith(2);
    });

    it("finds active global pause even when a metadata-role orchestrator appears first", async () => {
      const pausedUntil = new Date(Date.now() + 60_000).toISOString();
      const sessions = [
        makeSession({
          id: "control-session",
          projectId: "docs-app",
          metadata: { role: "orchestrator" },
        }),
        makeSession({
          id: "docs-orchestrator",
          projectId: "docs-app",
          metadata: {
            role: "orchestrator",
            globalPauseUntil: pausedUntil,
            globalPauseReason: "Rate limit hit",
            globalPauseSource: "docs-orchestrator",
          },
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(sessions);

      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.globalPause).toMatchObject({
        pausedUntil,
        reason: "Rate limit hit",
        sourceSessionId: "docs-orchestrator",
      });
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("rejects unauthorized requests before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const res = await sessionGET(
        makeRequest("http://localhost:3000/api/sessions/frontend-1", {
          headers: { authorization: "Bearer wrong-token" },
        }),
        { params: Promise.resolve({ id: "frontend-1" }) },
      );

      expect(res.status).toBe(401);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      expect(getServices).not.toHaveBeenCalled();
    });

    it("returns notificationState on detail responses", async () => {
      (mockSessionManager.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeSession({
          id: "backend-3",
          metadata: {
            "notifier.openclaw.status": "warn",
            "notifier.openclaw.consecutiveFailures": "1",
            "notifier.openclaw.lastFailureReason": "Connection refused",
          },
        }),
      );

      const res = await sessionGET(makeRequest("http://localhost:3000/api/sessions/backend-3"), {
        params: Promise.resolve({ id: "backend-3" }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.notificationState).toEqual({
        status: "warn",
        failingNotifiers: ["openclaw"],
        notifiers: [
          {
            name: "openclaw",
            status: "warn",
            consecutiveFailures: 1,
            lastFailureAt: null,
            lastFailureReason: "Connection refused",
            lastSuccessAt: null,
            lastEventType: null,
            lastPriority: null,
          },
        ],
      });
    });

    it("returns archived sessions via includeArchived lookup", async () => {
      (mockSessionManager.get as ReturnType<typeof vi.fn>).mockImplementation(
        async (id: string, options?: { includeArchived?: boolean }) => {
          if (id === "frontend-1" && options?.includeArchived) {
            return makeSession({
              id: "frontend-1",
              projectId: "my-app",
              status: "killed",
              activity: "exited",
            });
          }
          return null;
        },
      );

      const res = await sessionGET(makeRequest("http://localhost:3000/api/sessions/frontend-1"), {
        params: Promise.resolve({ id: "frontend-1" }),
      });

      expect(res.status).toBe(200);
      expect(mockSessionManager.get).toHaveBeenCalledWith("frontend-1", {
        includeArchived: true,
      });
    });

    it("normalizes fallback projectId on detail responses", async () => {
      (mockSessionManager.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeSession({
          id: "docs-9",
          projectId: "missing-project",
          status: "working",
          activity: "active",
        }),
      );

      const res = await sessionGET(makeRequest("http://localhost:3000/api/sessions/docs-9"), {
        params: Promise.resolve({ id: "docs-9" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        id: "docs-9",
        projectId: "docs-app",
      });
    });
  });

  // ── POST /api/spawn ────────────────────────────────────────────────

  describe("POST /api/spawn", () => {
    it("creates a session with valid input", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app", issueId: "INT-100" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.session).toBeDefined();
      expect(data.session.projectId).toBe("my-app");
      expect(data.session.status).toBe("spawning");
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
    });

    it("returns 400 when projectId is missing", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/projectId/);
    });

    it("returns 400 with invalid JSON", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(400);
    });

    it("handles missing issueId gracefully", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.session.issueId).toBeNull();
    });
  });

  describe("POST /api/orchestrators", () => {
    it("creates a per-project orchestrator with the generated prompt", async () => {
      (mockSessionManager.spawnOrchestrator as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
        }),
      );

      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await orchestratorsPOST(req);

      expect(res.status).toBe(201);
      expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledWith({
        projectId: "my-app",
        systemPrompt: expect.stringContaining("# My App Orchestrator"),
      });

      const data = await res.json();
      expect(data.orchestrator).toEqual({
        id: "my-app-orchestrator",
        projectId: "my-app",
        projectName: "My App",
      });
    });

    it("returns 404 for an unknown project", async () => {
      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({ projectId: "unknown-app" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await orchestratorsPOST(req);

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toMatch(/Unknown project/);
    });

    it("returns 400 for invalid JSON", async () => {
      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });

      const res = await orchestratorsPOST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid JSON body/);
    });

    it("returns 400 when projectId is missing", async () => {
      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      const res = await orchestratorsPOST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/projectId/);
    });

    it("returns 500 when orchestrator spawn fails", async () => {
      (mockSessionManager.spawnOrchestrator as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("boom"),
      );

      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await orchestratorsPOST(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("boom");
    });
  });

  // ── POST /api/sessions/:id/send ────────────────────────────────────

  describe("POST /api/sessions/:id/send", () => {
    it("rejects requests without auth before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const req = makeRawRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: "Fix the tests" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });

      expect(res.status).toBe(401);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      expect(getServices).not.toHaveBeenCalled();
    });

    it("sends a message to a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: "Fix the tests" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.message).toBe("Fix the tests");
    });

    it("returns 404 for unknown session", async () => {
      (mockSessionManager.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SessionNotFoundError("nonexistent"),
      );
      const req = makeRequest("/api/sessions/nonexistent/send", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("returns 400 when message is missing", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/message/);
    });

    it("returns 400 for invalid JSON body", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
    });

    it("returns 400 for control-char-only message", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: "\x00\x01\x02" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/empty/);
    });
  });

  describe("POST /api/sessions/:id/message", () => {
    it("rejects requests without auth before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const req = makeRawRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: JSON.stringify({ message: "Fix the tests" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });

      expect(res.status).toBe(401);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      expect(getServices).not.toHaveBeenCalled();
    });

    it("sends a message to a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: JSON.stringify({ message: "Fix the tests" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("returns 404 for unknown session", async () => {
      (mockSessionManager.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SessionNotFoundError("nonexistent"),
      );

      const req = makeRequest("/api/sessions/nonexistent/message", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await messagePOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("returns 400 when message is missing", async () => {
      const req = makeRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const res = await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/message/);
    });

    it("returns 400 for invalid JSON body", async () => {
      const req = makeRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      const res = await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
    });

    it("returns 400 for control-char-only message", async () => {
      const req = makeRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: JSON.stringify({ message: "\x00\x01\x02" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/empty/);
    });
  });

  // ── POST /api/sessions/:id/kill ────────────────────────────────────

  describe("POST /api/sessions/:id/kill", () => {
    it("rejects unauthorized requests before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const res = await killPOST(
        makeRequest("/api/sessions/backend-3/kill", {
          method: "POST",
          headers: { authorization: "Bearer wrong-token" },
        }),
        { params: Promise.resolve({ id: "backend-3" }) },
      );

      expect(res.status).toBe(401);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      expect(getServices).not.toHaveBeenCalled();
    });

    it.each([
      [
        "kill",
        () => killPOST(makeRequest("/api/sessions/backend-3/kill", { method: "POST" }), {
          params: Promise.resolve({ id: "backend-3" }),
        }),
      ],
      [
        "restore",
        () => restorePOST(makeRequest("/api/sessions/frontend-1/restore", { method: "POST" }), {
          params: Promise.resolve({ id: "frontend-1" }),
        }),
      ],
      [
        "send",
        () =>
          sendPOST(
            makeRequest("/api/sessions/backend-3/send", {
              method: "POST",
              body: JSON.stringify({ message: "Fix the tests" }),
              headers: { "Content-Type": "application/json" },
            }),
            { params: Promise.resolve({ id: "backend-3" }) },
          ),
      ],
      [
        "remap",
        () => remapPOST(makeRequest("/api/sessions/backend-3/remap", { method: "POST" }), {
          params: Promise.resolve({ id: "backend-3" }),
        }),
      ],
    ])("returns a JSON 500 when auth config reload fails for %s", async (_name, invoke) => {
      vi.mocked(getCachedConfig).mockImplementationOnce(() => {
        throw new Error("invalid config");
      });

      const res = await invoke();

      expect(res.status).toBe(500);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      await expect(res.json()).resolves.toMatchObject({ error: "invalid config" });
      expect(getServices).not.toHaveBeenCalled();
    });

    it("kills a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/kill", { method: "POST" });
      const res = await killPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.sessionId).toBe("backend-3");
    });

    it("returns 404 for unknown session", async () => {
      (mockSessionManager.kill as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SessionNotFoundError("nonexistent"),
      );
      const req = makeRequest("/api/sessions/nonexistent/kill", { method: "POST" });
      const res = await killPOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/sessions/:id/restore ─────────────────────────────────

  describe("POST /api/sessions/:id/restore", () => {
    it("rejects unauthorized requests before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const res = await restorePOST(
        makeRequest("/api/sessions/frontend-1/restore", {
          method: "POST",
          headers: { authorization: "Bearer wrong-token" },
        }),
        { params: Promise.resolve({ id: "frontend-1" }) },
      );

      expect(res.status).toBe(401);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      expect(getServices).not.toHaveBeenCalled();
    });

    it("restores a killed session", async () => {
      const req = makeRequest("/api/sessions/frontend-1/restore", { method: "POST" });
      const res = await restorePOST(req, { params: Promise.resolve({ id: "frontend-1" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.sessionId).toBe("frontend-1");
    });

    it("returns 404 for unknown session", async () => {
      const req = makeRequest("/api/sessions/nonexistent/restore", { method: "POST" });
      const res = await restorePOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("returns 409 for active session", async () => {
      const req = makeRequest("/api/sessions/backend-9/restore", { method: "POST" });
      const res = await restorePOST(req, { params: Promise.resolve({ id: "backend-9" }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toMatch(/not in a terminal state/);
    });
  });

  describe("POST /api/sessions/:id/remap", () => {
    it("rejects requests without auth before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const req = makeRawRequest("/api/sessions/backend-3/remap", { method: "POST" });
      const res = await remapPOST(req, { params: Promise.resolve({ id: "backend-3" }) });

      expect(res.status).toBe(401);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      expect(getServices).not.toHaveBeenCalled();
    });

    it("remaps a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/remap", { method: "POST" });
      const res = await remapPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.opencodeSessionId).toBe("ses_mock");
      expect(mockSessionManager.remap).toHaveBeenCalledWith("backend-3", true);
    });

    it("returns 404 when session is missing", async () => {
      (mockSessionManager.remap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SessionNotFoundError("missing"),
      );
      const req = makeRequest("/api/sessions/missing/remap", { method: "POST" });
      const res = await remapPOST(req, { params: Promise.resolve({ id: "missing" }) });
      expect(res.status).toBe(404);
    });

    it("returns 422 for non-opencode sessions", async () => {
      (mockSessionManager.remap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Session backend-3 is not using the opencode agent"),
      );
      const req = makeRequest("/api/sessions/backend-3/remap", { method: "POST" });
      const res = await remapPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toMatch(/not using the opencode agent/);
    });
  });

  // ── POST /api/prs/:id/merge ────────────────────────────────────────

  describe("POST /api/prs/:id/merge", () => {
    it("merges a mergeable PR", async () => {
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "432" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.prNumber).toBe(432);
    });

    it("returns 404 for unknown PR", async () => {
      const req = makeRequest("/api/prs/99999/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "99999" }) });
      expect(res.status).toBe(404);
    });

    it("returns 422 for non-mergeable PR", async () => {
      (mockSCM.getMergeability as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["CI checks failing", "Needs review"],
      });
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "432" }) });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toMatch(/not mergeable/);
      expect(data.blockers).toBeDefined();
    });

    it("returns 400 for non-numeric PR id", async () => {
      const req = makeRequest("/api/prs/abc/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "abc" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid PR number/);
    });

    it("returns 409 for merged PR", async () => {
      (mockSCM.getPRState as ReturnType<typeof vi.fn>).mockResolvedValueOnce("merged");
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "432" }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toMatch(/merged/);
    });
  });

  describe("POST /api/webhooks/[...slug]", () => {
    it("logs lifecycle check failures while returning 202", async () => {
      const webhookEvent: SCMWebhookEvent = {
        provider: "github",
        kind: "push",
        action: "updated",
        rawEventType: "push",
        repository: { owner: "acme", name: "my-app" },
        branch: "feat/hook-fail",
        data: {},
      };

      mockConfig.projects["my-app"] = {
        ...mockConfig.projects["my-app"],
        scm: {
          plugin: "github",
          webhook: {
            enabled: true,
            path: "/api/webhooks/github",
          },
        },
      };

      (mockSCM as SCM & {
        verifyWebhook: ReturnType<typeof vi.fn>;
        parseWebhook: ReturnType<typeof vi.fn>;
      }).verifyWebhook = vi.fn(async () => ({ ok: true }));
      (mockSCM as SCM & {
        verifyWebhook: ReturnType<typeof vi.fn>;
        parseWebhook: ReturnType<typeof vi.fn>;
      }).parseWebhook = vi.fn(async () => webhookEvent);
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSession({
          id: "backend-3",
          projectId: "my-app",
          status: "working",
          activity: "active",
          branch: "feat/hook-fail",
        }),
      ]);
      (mockLifecycleManager.check as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("boom"),
      );
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const req = new Request("http://localhost:3000/api/webhooks/github", {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "Content-Type": "application/json" },
        });

        const res = await webhooksPOST(req);
        expect(res.status).toBe(202);

        const data = await res.json();
        expect(data.lifecycleErrors).toEqual(["session backend-3: boom"]);
        expect(errorSpy).toHaveBeenCalledWith(
          "[webhook] lifecycle checks failed:",
          ["session backend-3: boom"],
        );
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  // ── GET /api/events (SSE) ──────────────────────────────────────────

  describe("GET /api/events", () => {
    it("returns SSE content type", async () => {
      const req = makeRequest("/api/events", { method: "GET" });
      const res = await eventsGET(req);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
    });

    it("streams initial snapshot event", async () => {
      const req = makeRequest("/api/events", { method: "GET" });
      const res = await eventsGET(req);
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      reader.cancel();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("data: ");
      const jsonStr = text.replace("data: ", "").trim();
      const event = JSON.parse(jsonStr);
      expect(event.type).toBe("snapshot");
      expect(event.correlationId).toBeTruthy();
      expect(Array.isArray(event.sessions)).toBe(true);
      expect(event.sessions.length).toBeGreaterThan(0);
      expect(event.sessions[0]).toHaveProperty("id");
      expect(event.sessions[0]).toHaveProperty("attentionLevel");
    });
  });

  describe("GET /api/observability", () => {
    it("returns observability summary with correlation header", async () => {
      const req = makeRequest("/api/observability", { method: "GET" });
      const res = await observabilityGET(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      const data = await res.json();
      expect(data).toHaveProperty("generatedAt");
      expect(data).toHaveProperty("overallStatus");
      expect(data).toHaveProperty("projects");
    });
  });
});
