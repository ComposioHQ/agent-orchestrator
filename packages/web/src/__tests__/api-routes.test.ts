import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  SessionNotFoundError,
  SessionNotRestorableError,
  type Session,
  type SessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SCM,
  type Tracker,
} from "@composio/ao-core";
import * as serialize from "@/lib/serialize";
import { getSCM } from "@/lib/services";

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

const mockSCM: SCM = {
  name: "github",
  verifyWebhook: vi.fn(async () => ({
    ok: true,
    eventType: "pull_request",
    deliveryId: "delivery-1",
  })),
  parseWebhook: vi.fn(async () => ({
    provider: "github",
    kind: "pull_request" as const,
    action: "opened",
    rawEventType: "pull_request",
    deliveryId: "delivery-1",
    repository: { owner: "acme", name: "my-app" },
    prNumber: 432,
    branch: "feat/health-check",
    data: {},
  })),
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

const mockTracker: Tracker = {
  name: "linear",
  getIssue: vi.fn(async (id: string) => ({
    id,
    title: `Issue ${id}`,
    description: "",
    url: `https://linear.app/topshark/issue/${id}`,
    state: "open",
    labels: [],
  })),
  isCompleted: vi.fn(async () => false),
  issueUrl: vi.fn((identifier: string) => `https://linear.app/topshark/issue/${identifier}`),
  issueLabel: vi.fn((url: string) => url.split("/").pop() ?? url),
  branchName: vi.fn((identifier: string) => `feat/${identifier}`),
  generatePrompt: vi.fn(async (identifier: string) => `Prompt for ${identifier}`),
};

const mockRegistry: PluginRegistry = {
  register: vi.fn(),
  get: vi.fn((slot: string) => {
    if (slot === "tracker") return mockTracker;
    if (slot === "scm") return mockSCM;
    return null;
  }) as PluginRegistry["get"],
  list: vi.fn(() => []),
  loadBuiltins: vi.fn(async () => {}),
  loadFromConfig: vi.fn(async () => {}),
};

const mockLifecycleManager = {
  check: vi.fn(async () => {}),
  getStates: vi.fn(() => new Map()),
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
      tracker: { plugin: "linear" },
      scm: { plugin: "github", webhook: {} },
    },
  },
  notifiers: {},
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
    lifecycleManager: mockLifecycleManager,
  })),
  getSCM: vi.fn(() => mockSCM),
  startBacklogPoller: vi.fn(() => {}),
}));

vi.mock("@/lib/project-name", () => ({
  getProjectName: () => "My App",
  getPrimaryProjectId: () => "my-app",
  getAllProjects: () => [{ id: "my-app", name: "My App" }],
}));

// ── Import routes after mocking ───────────────────────────────────────

import { GET as sessionsGET } from "@/app/api/sessions/route";
import { GET as projectsGET } from "@/app/api/projects/route";
import { POST as spawnPOST } from "@/app/api/spawn/route";
import { POST as sendPOST } from "@/app/api/sessions/[id]/send/route";
import { POST as messagePOST } from "@/app/api/sessions/[id]/message/route";
import { POST as killPOST } from "@/app/api/sessions/[id]/kill/route";
import { POST as restorePOST } from "@/app/api/sessions/[id]/restore/route";
import { POST as remapPOST } from "@/app/api/sessions/[id]/remap/route";
import { POST as mergePOST } from "@/app/api/prs/[id]/merge/route";
import { GET as eventsGET } from "@/app/api/events/route";
import { POST as webhookPOST } from "@/app/api/webhooks/[...slug]/route";

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-set default return values
  (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue(testSessions);
  (mockSessionManager.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (id: string) => testSessions.find((s) => s.id === id) ?? null,
  );
  (mockSCM.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    eventType: "pull_request",
    deliveryId: "delivery-1",
  });
  (mockSCM.parseWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
    provider: "github",
    kind: "pull_request",
    action: "opened",
    rawEventType: "pull_request",
    deliveryId: "delivery-1",
    repository: { owner: "acme", name: "my-app" },
    prNumber: 432,
    branch: "feat/health-check",
    data: {},
  });
  (mockTracker.getIssue as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => ({
    id,
    title: `Issue ${id}`,
    description: "",
    url: `https://linear.app/topshark/issue/${id}`,
    state: "open",
    labels: [],
  }));
});

describe("API Routes", () => {
  // ── GET /api/sessions ──────────────────────────────────────────────

  describe("GET /api/sessions", () => {
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
    });

    it("returns full external issueUrl values for tracker-backed sessions", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      expect(res.status).toBe(200);

      const data = await res.json();
      const session = data.sessions.find((s: { id: string }) => s.id === "frontend-1");

      expect(session.issueId).toBe("INT-1270");
      expect(session.issueUrl).toBe("https://linear.app/topshark/issue/INT-1270");
      expect(session.issueLabel).toBe("INT-1270");
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

  // ── POST /api/sessions/:id/send ────────────────────────────────────

  describe("POST /api/sessions/:id/send", () => {
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

  // ── GET /api/events (SSE) ──────────────────────────────────────────

  describe("GET /api/events", () => {
    it("returns SSE content type", async () => {
      const res = await eventsGET(makeRequest("http://localhost:3000/api/events"));
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
    });

    it("streams initial snapshot event", async () => {
      const res = await eventsGET(makeRequest("http://localhost:3000/api/events"));
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      reader.cancel();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("data: ");
      const jsonStr = text.replace("data: ", "").trim();
      const event = JSON.parse(jsonStr);
      expect(event.type).toBe("snapshot");
      expect(Array.isArray(event.sessions)).toBe(true);
      expect(event.sessions.length).toBeGreaterThan(0);
      expect(event.sessions[0]).toHaveProperty("id");
      expect(event.sessions[0]).toHaveProperty("attentionLevel");
    });

    it("excludes orchestrator sessions from snapshot", async () => {
      const sessionsWithOrchestrator = [
        ...testSessions,
        makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          status: "working",
          activity: "active",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        sessionsWithOrchestrator,
      );

      const res = await eventsGET(makeRequest("http://localhost:3000/api/events"));
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      reader.cancel();
      const text = new TextDecoder().decode(value);
      const jsonStr = text.replace("data: ", "").trim();
      const event = JSON.parse(jsonStr);

      const sessionIds = event.sessions.map((s: { id: string }) => s.id);
      expect(sessionIds).not.toContain("my-app-orchestrator");
      expect(sessionIds.every((id: string) => !id.endsWith("-orchestrator"))).toBe(true);
    });

    it("filters sessions by project query param", async () => {
      const multiProjectSessions = [
        ...testSessions,
        makeSession({
          id: "other-app-1",
          projectId: "other-app",
          status: "working",
          activity: "active",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        multiProjectSessions,
      );

      const res = await eventsGET(makeRequest("http://localhost:3000/api/events?project=my-app"));
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      reader.cancel();
      const text = new TextDecoder().decode(value);
      const event = JSON.parse(text.replace("data: ", "").trim());

      expect(event.sessions.every((s: { id: string }) => s.id !== "other-app-1")).toBe(true);
    });

    it("returns all non-orchestrator sessions when project=all", async () => {
      const multiProjectSessions = [
        ...testSessions,
        makeSession({
          id: "other-app-1",
          projectId: "other-app",
          status: "working",
          activity: "active",
        }),
        makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          status: "working",
          activity: "active",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        multiProjectSessions,
      );

      const res = await eventsGET(makeRequest("http://localhost:3000/api/events?project=all"));
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      reader.cancel();
      const text = new TextDecoder().decode(value);
      const event = JSON.parse(text.replace("data: ", "").trim());

      // Should include both projects' worker sessions
      const sessionIds = event.sessions.map((s: { id: string }) => s.id);
      expect(sessionIds).toContain("other-app-1");
      // But exclude orchestrator
      expect(sessionIds).not.toContain("my-app-orchestrator");
    });
  });

  // ── GET /api/sessions?project=X (project filtering) ───────────────────────

  describe("GET /api/sessions?project=X", () => {
    it("filters sessions by projectId", async () => {
      const multiProjectSessions = [
        ...testSessions,
        makeSession({
          id: "other-app-1",
          projectId: "other-app",
          status: "working",
          activity: "active",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        multiProjectSessions,
      );

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=my-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessions.every((s: { projectId: string }) => s.projectId === "my-app")).toBe(
        true,
      );
    });

    it("filters sessions by sessionPrefix when projectId does not match", async () => {
      const prefixMatchSessions = [
        makeSession({ id: "my-app-1", projectId: "", status: "working", activity: "active" }),
        makeSession({
          id: "backend-1",
          projectId: "backend",
          status: "working",
          activity: "active",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        prefixMatchSessions,
      );

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=my-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessions.length).toBe(1);
      expect(data.sessions[0].id).toBe("my-app-1");
    });

    it("returns all sessions when project=all", async () => {
      const multiProjectSessions = [
        ...testSessions,
        makeSession({
          id: "other-app-1",
          projectId: "other-app",
          status: "working",
          activity: "active",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        multiProjectSessions,
      );

      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions?project=all"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessions.length).toBe(multiProjectSessions.length);
    });

    it("returns empty array for non-existent project", async () => {
      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=nonexistent"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessions).toEqual([]);
      expect(data.stats.totalSessions).toBe(0);
    });

    it("finds orchestrator for the filtered project only", async () => {
      const multiProjectSessions = [
        ...testSessions.filter((s) => !s.id.endsWith("-orchestrator")),
        makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          status: "working",
          activity: "active",
        }),
        makeSession({
          id: "other-app-orchestrator",
          projectId: "other-app",
          status: "working",
          activity: "active",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        multiProjectSessions,
      );

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=my-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.orchestratorId).toBe("my-app-orchestrator");
    });

    it("stats reflect only filtered sessions", async () => {
      const multiProjectSessions = [
        makeSession({
          id: "my-app-1",
          projectId: "my-app",
          status: "needs_input",
          activity: "waiting_input",
        }),
        makeSession({
          id: "my-app-2",
          projectId: "my-app",
          status: "mergeable",
          activity: "idle",
          pr: {
            number: 1,
            url: "",
            title: "",
            owner: "",
            repo: "",
            branch: "",
            baseBranch: "",
            isDraft: false,
          },
        }),
        makeSession({
          id: "other-app-1",
          projectId: "other-app",
          status: "needs_input",
          activity: "waiting_input",
        }),
      ];
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        multiProjectSessions,
      );

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=my-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.stats.totalSessions).toBe(2);
      expect(data.stats.workingSessions).toBe(2);
    });
  });

  // ── GET /api/projects ────────────────────────────────────────────────

  describe("GET /api/projects", () => {
    it("returns list of configured projects", async () => {
      const res = await projectsGET(makeRequest("http://localhost:3000/api/projects"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.projects).toBeDefined();
      expect(Array.isArray(data.projects)).toBe(true);
      expect(data.projects.length).toBe(1);
      expect(data.projects[0]).toHaveProperty("id");
      expect(data.projects[0]).toHaveProperty("name");
    });

    it("project includes id and name", async () => {
      const res = await projectsGET(makeRequest("http://localhost:3000/api/projects"));
      const data = await res.json();
      expect(data.projects[0].id).toBe("my-app");
      expect(data.projects[0].name).toBe("My App");
    });
  });

  describe("POST /api/webhooks/[...slug]", () => {
    it("verifies webhook and triggers lifecycle checks for matching sessions", async () => {
      const req = makeRequest("/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ any: "payload" }),
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-1",
        },
      });

      const res = await webhookPOST(req);
      expect(res.status).toBe(202);
      expect(mockLifecycleManager.check).toHaveBeenCalledWith("backend-7");
      const data = await res.json();
      expect(data.sessionIds).toEqual(["backend-7"]);
    });

    it("returns 401 when webhook verification fails", async () => {
      (mockSCM.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        reason: "Webhook signature verification failed",
      });

      const req = makeRequest("/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ any: "payload" }),
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
        },
      });

      const res = await webhookPOST(req);
      expect(res.status).toBe(401);
      expect(mockLifecycleManager.check).not.toHaveBeenCalled();
    });

    it("returns 404 when no project is configured for the webhook path", async () => {
      const req = makeRequest("/api/webhooks/gitlab", {
        method: "POST",
        body: JSON.stringify({ any: "payload" }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await webhookPOST(req);
      expect(res.status).toBe(404);
    });

    it("returns 413 when content-length exceeds configured maxBodyBytes", async () => {
      const originalWebhook = mockConfig.projects["my-app"]?.scm?.webhook;
      if (mockConfig.projects["my-app"]?.scm) {
        mockConfig.projects["my-app"].scm.webhook = { maxBodyBytes: 1 };
      }

      const req = makeRequest("/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ any: "payload" }),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "50",
          "x-github-event": "pull_request",
        },
      });

      const res = await webhookPOST(req);
      expect(res.status).toBe(413);

      if (mockConfig.projects["my-app"]?.scm) {
        mockConfig.projects["my-app"].scm.webhook = originalWebhook;
      }
    });

    it("does not apply early 413 when any matching candidate is unbounded", async () => {
      const originalMyAppWebhook = mockConfig.projects["my-app"]?.scm?.webhook;
      const originalOtherProject = mockConfig.projects["other-app"];

      if (mockConfig.projects["my-app"]?.scm) {
        mockConfig.projects["my-app"].scm.webhook = {
          path: "/api/webhooks/github",
          maxBodyBytes: 1,
        };
      }
      mockConfig.projects["other-app"] = {
        name: "Other App",
        repo: "acme/other-app",
        path: "/tmp/other-app",
        defaultBranch: "main",
        sessionPrefix: "other-app",
        scm: { plugin: "github", webhook: { path: "/api/webhooks/github" } },
      };

      const req = makeRequest("/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ any: "payload" }),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "50",
          "x-github-event": "pull_request",
        },
      });

      const res = await webhookPOST(req);
      expect(res.status).toBe(202);

      if (mockConfig.projects["my-app"]?.scm) {
        mockConfig.projects["my-app"].scm.webhook = originalMyAppWebhook;
      }
      if (originalOtherProject) {
        mockConfig.projects["other-app"] = originalOtherProject;
      } else {
        delete mockConfig.projects["other-app"];
      }
    });

    it("continues after parse errors and still returns 202", async () => {
      (mockSCM.parseWebhook as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Invalid webhook payload"),
      );

      const req = makeRequest("/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ any: "payload" }),
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
        },
      });

      const res = await webhookPOST(req);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(Array.isArray(data.parseErrors)).toBe(true);
      expect(data.parseErrors[0]).toMatch(/Invalid webhook payload/);
    });

    it("continues lifecycle checks when one session check throws", async () => {
      const matchingSessions: Session[] = [
        makeSession({
          id: "backend-7",
          projectId: "my-app",
          status: "working",
          activity: "active",
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
        makeSession({
          id: "backend-8",
          projectId: "my-app",
          status: "working",
          activity: "active",
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

      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce(matchingSessions);
      (mockLifecycleManager.check as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("check failed"))
        .mockResolvedValueOnce(undefined);

      const req = makeRequest("/api/webhooks/github", {
        method: "POST",
        body: JSON.stringify({ any: "payload" }),
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
        },
      });

      const res = await webhookPOST(req);
      expect(res.status).toBe(202);
      expect(mockLifecycleManager.check).toHaveBeenCalledTimes(2);

      const data = await res.json();
      expect(data.sessionIds).toContain("backend-7");
      expect(data.sessionIds).toContain("backend-8");
      expect(Array.isArray(data.lifecycleErrors)).toBe(true);
      expect(data.lifecycleErrors[0]).toContain("backend-7");
      expect(data.lifecycleErrors[0]).toContain("check failed");
    });
  });
});
