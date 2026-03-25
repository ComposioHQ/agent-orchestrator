import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleManager, OrchestratorConfig, PluginRegistry, Session, SessionManager } from "@composio/ao-core";
import {
  SessionNotFoundError,
  SessionNotRestorableError,
  WorkspaceMissingError,
} from "@composio/ao-core";
import { getServices } from "@/lib/services";
import { getCachedConfig } from "@/lib/config-cache";

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    id: overrides.id,
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2026-03-25T00:00:00.000Z"),
    lastActivityAt: new Date("2026-03-25T00:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

const testSessions: Session[] = [
  makeSession({ id: "worker-1", status: "working", projectId: "my-app" }),
  makeSession({
    id: "worker-2",
    status: "stuck",
    projectId: "docs-app",
    metadata: {
      "notifier.openclaw.status": "warn",
      "notifier.openclaw.consecutiveFailures": "2",
    },
  }),
  makeSession({ id: "orchestrator-1", projectId: "my-app", metadata: { role: "orchestrator" } }),
];

const mockSessionManager = {
  list: vi.fn(async () => testSessions),
  get: vi.fn(async (id: string) => testSessions.find((session) => session.id === id) ?? null),
  kill: vi.fn(async (_id: string) => {}),
  restore: vi.fn(async (id: string) => testSessions.find((session) => session.id === id) ?? null),
} as unknown as SessionManager;

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
    registry: {} as PluginRegistry,
    sessionManager: mockSessionManager,
    lifecycleManager: {} as LifecycleManager,
  })),
}));

import { checkAuth } from "@/app/api/ao/_auth";
import { GET as statusGET } from "@/app/api/ao/status/route";
import { GET as sessionsGET } from "@/app/api/ao/sessions/route";
import { GET as sessionGET } from "@/app/api/ao/sessions/[id]/route";
import { POST as retryPOST } from "@/app/api/ao/sessions/[id]/retry/route";
import { POST as killPOST } from "@/app/api/ao/sessions/[id]/kill/route";
import webPackage from "../../package.json";

function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(new URL(path, "http://localhost:3000"), init);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockConfig.api = { token: "secret-token" };
  vi.mocked(getServices).mockResolvedValue({
    config: mockConfig,
    registry: {} as PluginRegistry,
    sessionManager: mockSessionManager,
    lifecycleManager: {} as LifecycleManager,
  });
  vi.mocked(getCachedConfig).mockReturnValue(mockConfig);
  vi.mocked(mockSessionManager.list).mockResolvedValue(testSessions);
  vi.mocked(mockSessionManager.get).mockImplementation(
    async (id: string) => testSessions.find((session) => session.id === id) ?? null,
  );
  vi.mocked(mockSessionManager.restore).mockResolvedValue(testSessions[0]);
  vi.mocked(mockSessionManager.kill).mockResolvedValue(undefined);
});

describe("AO API Routes", () => {
  describe("auth", () => {
    it("request with correct token passes through", () => {
      const result = checkAuth(
        makeRequest("/api/ao/status", {
          headers: { authorization: "Bearer secret-token" },
        }),
        "secret-token",
      );

      expect(result).toBeNull();
    });

    it("request with wrong token returns 401", async () => {
      const result = checkAuth(
        makeRequest("/api/ao/status", {
          headers: { authorization: "Bearer wrong-token" },
        }),
        "secret-token",
      );

      expect(result?.status).toBe(401);
      await expect(result?.json()).resolves.toEqual({ error: "Unauthorized" });
    });

    it("request when no token configured passes through", () => {
      const result = checkAuth(makeRequest("/api/ao/status"), undefined);

      expect(result).toBeNull();
    });

    it("request when token is blank fails closed", async () => {
      const result = checkAuth(makeRequest("/api/ao/status"), "   ");

      expect(result?.status).toBe(401);
      await expect(result?.json()).resolves.toEqual({ error: "Unauthorized" });
    });
  });

  describe("GET /api/ao/status", () => {
    it("rejects unauthorized requests before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const response = await statusGET(
        makeRequest("/api/ao/status", {
          headers: { authorization: "Bearer wrong-token" },
        }),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(getServices).not.toHaveBeenCalled();
    });

    it("returns correct session count", async () => {
      const response = await statusGET(
        makeRequest("/api/ao/status", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        version: webPackage.version,
        sessionCount: testSessions.length,
      });
    });

    it('notifierHealth is "warn" when any session has a warned notifier', async () => {
      const response = await statusGET(
        makeRequest("/api/ao/status", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      await expect(response.json()).resolves.toMatchObject({
        notifierHealth: "warn",
      });
    });

    it('notifierHealth is "ok" when no sessions are warned', async () => {
      vi.mocked(mockSessionManager.list).mockResolvedValue([
        makeSession({ id: "worker-1", projectId: "my-app" }),
        makeSession({ id: "worker-2", projectId: "docs-app", status: "needs_input" }),
      ]);

      const response = await statusGET(
        makeRequest("/api/ao/status", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      const data = await response.json();
      expect(data.notifierHealth).toBe("ok");
      expect(typeof data.uptime).toBe("number");
    });
  });

  describe("GET /api/ao/sessions", () => {
    it("rejects unauthorized requests before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const response = await sessionsGET(
        makeRequest("/api/ao/sessions", {
          headers: { authorization: "Bearer wrong-token" },
        }),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(getServices).not.toHaveBeenCalled();
    });

    it("returns all sessions when no filters", async () => {
      const response = await sessionsGET(
        makeRequest("/api/ao/sessions", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(testSessions.length);
      expect(
        data.find((session: { id: string }) => session.id === "worker-2")?.notificationState?.status,
      ).toBe("warn");
    });

    it("filters by status param correctly", async () => {
      const response = await sessionsGET(
        makeRequest("/api/ao/sessions?status=stuck,killed", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      const data = await response.json();
      expect(data.map((session: { id: string }) => session.id)).toEqual(["worker-2"]);
    });

    it("filters by project param correctly", async () => {
      const response = await sessionsGET(
        makeRequest("/api/ao/sessions?project=docs-app", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      const data = await response.json();
      expect(data.map((session: { id: string }) => session.id)).toEqual(["worker-2"]);
    });

    it("filters by project using session prefix fallback semantics", async () => {
      vi.mocked(mockSessionManager.list).mockResolvedValue([
        makeSession({
          id: "docs-9",
          projectId: "missing-project",
          status: "working",
        }),
      ]);

      const response = await sessionsGET(
        makeRequest("/api/ao/sessions?project=docs-app", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      const data = await response.json();
      expect(data.map((session: { id: string }) => session.id)).toEqual(["docs-9"]);
      expect(data[0]?.projectId).toBe("docs-app");
    });

    it("does not match overlapping session prefixes when filtering by project", async () => {
      mockConfig.projects["app"] = {
        name: "App",
        repo: "acme/app",
        path: "/tmp/app",
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      };
      mockConfig.projects["apple"] = {
        name: "Apple",
        repo: "acme/apple",
        path: "/tmp/apple",
        defaultBranch: "main",
        sessionPrefix: "apple",
        scm: { plugin: "github" },
      };
      vi.mocked(mockSessionManager.list).mockResolvedValue([
        makeSession({ id: "app-1", projectId: "missing-project" }),
        makeSession({ id: "apple-1", projectId: "missing-project" }),
      ]);

      const response = await sessionsGET(
        makeRequest("/api/ao/sessions?project=app", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([
        expect.objectContaining({ id: "app-1", projectId: "app" }),
      ]);
    });

    it("matches the longest session prefix when prefixes are nested", async () => {
      mockConfig.projects["app"] = {
        name: "App",
        repo: "acme/app",
        path: "/tmp/app",
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      };
      mockConfig.projects["app-foo"] = {
        name: "App Foo",
        repo: "acme/app-foo",
        path: "/tmp/app-foo",
        defaultBranch: "main",
        sessionPrefix: "app-foo",
        scm: { plugin: "github" },
      };
      vi.mocked(mockSessionManager.list).mockResolvedValue([
        makeSession({ id: "app-1", projectId: "missing-project" }),
        makeSession({ id: "app-foo-1", projectId: "missing-project" }),
      ]);

      const appResponse = await sessionsGET(
        makeRequest("/api/ao/sessions?project=app", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );
      const appFooResponse = await sessionsGET(
        makeRequest("/api/ao/sessions?project=app-foo", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      await expect(appResponse.json()).resolves.toEqual([
        expect.objectContaining({ id: "app-1", projectId: "app" }),
      ]);
      await expect(appFooResponse.json()).resolves.toEqual([
        expect.objectContaining({ id: "app-foo-1", projectId: "app-foo" }),
      ]);
    });

    it('warned=true returns only sessions with notificationState.status === "warn"', async () => {
      const response = await sessionsGET(
        makeRequest("/api/ao/sessions?warned=true", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      const data = await response.json();
      expect(data.map((session: { id: string }) => session.id)).toEqual(["worker-2"]);
    });
  });

  describe("GET /api/ao/sessions/[id]", () => {
    it("rejects unauthorized requests before validating the id", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const response = await sessionGET(
        makeRequest("/api/ao/sessions/bad/id", {
          headers: { authorization: "Bearer wrong-token" },
        }),
        { params: Promise.resolve({ id: "bad/id" }) },
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(getServices).not.toHaveBeenCalled();
    });

    it("returns correct session", async () => {
      const response = await sessionGET(
        makeRequest("/api/ao/sessions/worker-2", {
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "worker-2" }) },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "worker-2",
        notificationState: { status: "warn" },
      });
      expect(mockSessionManager.get).toHaveBeenCalledWith("worker-2", { includeArchived: true });
    });

    it("returns archived sessions through includeArchived lookup", async () => {
      vi.mocked(mockSessionManager.get).mockResolvedValueOnce(
        makeSession({
          id: "docs-9",
          projectId: "missing-project",
          status: "killed",
          activity: "exited",
        }),
      );

      const response = await sessionGET(
        makeRequest("/api/ao/sessions/docs-9", {
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "docs-9" }) },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "docs-9",
        status: "killed",
        projectId: "docs-app",
      });
      expect(mockSessionManager.get).toHaveBeenCalledWith("docs-9", { includeArchived: true });
    });

    it("returns 404 for unknown id", async () => {
      const response = await sessionGET(
        makeRequest("/api/ao/sessions/missing", {
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "missing" }) },
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Session not found" });
    });

    it("returns 400 for invalid id", async () => {
      const response = await sessionGET(
        makeRequest("/api/ao/sessions/bad/id", {
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "bad/id" }) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "id must match [a-zA-Z0-9_-]+" });
    });
  });

  describe("POST /api/ao/sessions/[id]/retry", () => {
    it("rejects unauthorized retry requests before initializing services", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const response = await retryPOST(
        makeRequest("/api/ao/sessions/worker-1/retry", {
          method: "POST",
          headers: { authorization: "Bearer wrong-token" },
        }),
        { params: Promise.resolve({ id: "worker-1" }) },
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(getServices).not.toHaveBeenCalled();
    });

    it("calls restore on session manager and returns { ok: true } for archived sessions", async () => {
      vi.mocked(mockSessionManager.restore).mockResolvedValueOnce(
        makeSession({ id: "archived-1", status: "spawning", activity: "active" }),
      );

      const response = await retryPOST(
        makeRequest("/api/ao/sessions/archived-1/retry", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "archived-1" }) },
      );

      expect(response.status).toBe(200);
      expect(mockSessionManager.restore).toHaveBeenCalledWith("archived-1");
      expect(mockSessionManager.get).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual({ ok: true });
    });

    it("returns 404 for unknown id", async () => {
      vi.mocked(mockSessionManager.restore).mockRejectedValueOnce(new SessionNotFoundError("missing"));

      const response = await retryPOST(
        makeRequest("/api/ao/sessions/missing/retry", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "missing" }) },
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Session not found" });
    });

    it("returns 400 for invalid id", async () => {
      const response = await retryPOST(
        makeRequest("/api/ao/sessions/bad/id/retry", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "bad/id" }) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "id must match [a-zA-Z0-9_-]+" });
    });

    it("returns 409 with { ok: false, error } when restore throws SessionNotRestorableError", async () => {
      vi.mocked(mockSessionManager.restore).mockRejectedValueOnce(
        new SessionNotRestorableError("worker-1", "session is not in a terminal state"),
      );

      const response = await retryPOST(
        makeRequest("/api/ao/sessions/worker-1/retry", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "worker-1" }) },
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "Session worker-1 cannot be restored: session is not in a terminal state",
      });
    });

    it("returns 422 with { ok: false, error } when restore throws WorkspaceMissingError", async () => {
      vi.mocked(mockSessionManager.restore).mockRejectedValueOnce(
        new WorkspaceMissingError("/tmp/missing", "restore failed"),
      );

      const response = await retryPOST(
        makeRequest("/api/ao/sessions/worker-1/retry", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "worker-1" }) },
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "Workspace missing at /tmp/missing: restore failed",
      });
    });

    it("returns 500 with { ok: false, error } when restore throws generic error", async () => {
      vi.mocked(mockSessionManager.restore).mockRejectedValueOnce(new Error("restore failed"));

      const response = await retryPOST(
        makeRequest("/api/ao/sessions/worker-1/retry", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "worker-1" }) },
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ ok: false, error: "restore failed" });
    });
  });

  describe("POST /api/ao/sessions/[id]/kill", () => {
    it("rejects unauthorized kill requests before validating the id", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services should not initialize"));

      const response = await killPOST(
        makeRequest("/api/ao/sessions/bad/id/kill", {
          method: "POST",
          headers: { authorization: "Bearer wrong-token" },
        }),
        { params: Promise.resolve({ id: "bad/id" }) },
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(getServices).not.toHaveBeenCalled();
    });

    it("calls kill on session manager and returns { ok: true }", async () => {
      const response = await killPOST(
        makeRequest("/api/ao/sessions/worker-1/kill", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "worker-1" }) },
      );

      expect(response.status).toBe(200);
      expect(mockSessionManager.kill).toHaveBeenCalledWith("worker-1");
      await expect(response.json()).resolves.toEqual({ ok: true });
    });

    it("returns 404 for unknown id", async () => {
      vi.mocked(mockSessionManager.kill).mockRejectedValueOnce(new SessionNotFoundError("missing"));

      const response = await killPOST(
        makeRequest("/api/ao/sessions/missing/kill", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "missing" }) },
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Session not found" });
    });

    it("returns 400 for invalid id", async () => {
      const response = await killPOST(
        makeRequest("/api/ao/sessions/bad/id/kill", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "bad/id" }) },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "id must match [a-zA-Z0-9_-]+" });
    });

    it("returns 500 with { ok: false, error } when kill throws", async () => {
      vi.mocked(mockSessionManager.kill).mockRejectedValueOnce(new Error("kill failed"));

      const response = await killPOST(
        makeRequest("/api/ao/sessions/worker-1/kill", {
          method: "POST",
          headers: { authorization: "Bearer secret-token" },
        }),
        { params: Promise.resolve({ id: "worker-1" }) },
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ ok: false, error: "kill failed" });
    });
  });

  describe("error handling", () => {
    it("returns 500 when getServices throws", async () => {
      vi.mocked(getServices).mockRejectedValueOnce(new Error("services unavailable"));

      const response = await statusGET(
        makeRequest("/api/ao/status", {
          headers: { authorization: "Bearer secret-token" },
        }),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "services unavailable" });
    });
  });
});
