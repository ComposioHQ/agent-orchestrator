import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ArchivedSessionEntry } from "@composio/ao-core";

// ── Mock @composio/ao-core ────────────────────────────────────────────
// vi.hoisted() ensures these are available when vi.mock factories are hoisted

const { mockLoadConfig, mockListAllArchivedSessions, mockGetSessionsDir } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockListAllArchivedSessions: vi.fn(),
  mockGetSessionsDir: vi.fn((_configPath: string, _projectPath: string) =>
    "/tmp/mock-sessions",
  ),
}));

vi.mock("@composio/ao-core", () => ({
  loadConfig: mockLoadConfig,
  listAllArchivedSessions: mockListAllArchivedSessions,
  getSessionsDir: mockGetSessionsDir,
}));

// ── Import route after mocking ────────────────────────────────────────

import { GET } from "@/app/api/sessions/archived/route";

// ── Test helpers ──────────────────────────────────────────────────────

const mockConfig = {
  configPath: "/tmp/ao-test/agent-orchestrator.yaml",
  projects: {
    "my-app": {
      name: "My App",
      repo: "acme/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "app",
    },
  },
};

function makeArchiveEntry(
  sessionId: string,
  archivedAt: Date,
  overrides: Partial<Record<string, string>> = {},
): ArchivedSessionEntry {
  return {
    sessionId,
    archivedAt,
    metadata: {
      status: "merged",
      branch: `feat/${sessionId}`,
      pr: `https://github.com/acme/my-app/pull/${Math.floor(Math.random() * 1000)}`,
      project: "my-app",
      ...overrides,
    },
  };
}

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue(mockConfig);
  mockListAllArchivedSessions.mockReturnValue([]);
});

describe("GET /api/sessions/archived", () => {
  it("returns empty archived array when no sessions are archived", async () => {
    const res = await GET(makeRequest("http://localhost:3000/api/sessions/archived"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.archived).toEqual([]);
  });

  it("returns archived sessions with correct shape", async () => {
    const entry = makeArchiveEntry("ao-1", new Date("2026-04-03T06:48:49.236Z"));
    mockListAllArchivedSessions.mockReturnValue([entry]);

    const res = await GET(makeRequest("http://localhost:3000/api/sessions/archived"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.archived).toHaveLength(1);

    const session = data.archived[0];
    expect(session.sessionId).toBe("ao-1");
    expect(session.archivedAt).toBe("2026-04-03T06:48:49.236Z");
    expect(session.status).toBe("merged");
    expect(session.branch).toBe("feat/ao-1");
    expect(session.prNumber).toBeTypeOf("number");
    expect(session.prUrl).toContain("github.com");
    expect(session.projectId).toBe("my-app");
  });

  it("passes limit param to listAllArchivedSessions", async () => {
    const res = await GET(
      makeRequest("http://localhost:3000/api/sessions/archived?limit=5"),
    );
    expect(res.status).toBe(200);
    expect(mockListAllArchivedSessions).toHaveBeenCalledWith(expect.any(String), 5);
  });

  it("uses default limit of 10 when no limit param given", async () => {
    const res = await GET(makeRequest("http://localhost:3000/api/sessions/archived"));
    expect(res.status).toBe(200);
    expect(mockListAllArchivedSessions).toHaveBeenCalledWith(expect.any(String), 10);
  });

  it("clamps limit to MAX_LIMIT (100)", async () => {
    const res = await GET(
      makeRequest("http://localhost:3000/api/sessions/archived?limit=9999"),
    );
    expect(res.status).toBe(200);
    expect(mockListAllArchivedSessions).toHaveBeenCalledWith(expect.any(String), 100);
  });

  it("sorts multiple entries newest-first", async () => {
    mockListAllArchivedSessions.mockReturnValue([
      makeArchiveEntry("ao-old", new Date("2026-01-01T00:00:00.000Z")),
      makeArchiveEntry("ao-new", new Date("2026-04-03T00:00:00.000Z")),
    ]);

    const res = await GET(makeRequest("http://localhost:3000/api/sessions/archived"));
    const data = await res.json();
    expect(data.archived[0].sessionId).toBe("ao-new");
    expect(data.archived[1].sessionId).toBe("ao-old");
  });

  it("filters by project when project param given", async () => {
    const res = await GET(
      makeRequest("http://localhost:3000/api/sessions/archived?project=my-app"),
    );
    expect(res.status).toBe(200);
    // listAllArchivedSessions should be called for my-app project dir
    expect(mockListAllArchivedSessions).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when loadConfig throws", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("No config found");
    });

    const res = await GET(makeRequest("http://localhost:3000/api/sessions/archived"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/No config found/);
  });

  it("returns null prNumber when no pr in metadata", async () => {
    mockListAllArchivedSessions.mockReturnValue([
      makeArchiveEntry("ao-no-pr", new Date("2026-04-03T00:00:00.000Z"), { pr: "" }),
    ]);

    const res = await GET(makeRequest("http://localhost:3000/api/sessions/archived"));
    const data = await res.json();
    expect(data.archived[0].prNumber).toBeNull();
    expect(data.archived[0].prUrl).toBeNull();
  });
});
