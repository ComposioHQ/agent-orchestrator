import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs/promises before importing the module under test
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("../paths.js", () => ({
  getSessionsDir: vi.fn(),
}));

vi.mock("../key-value.js", () => ({
  parseKeyValueContent: vi.fn(),
}));

vi.mock("../types.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isOrchestratorSession: vi.fn(),
  };
});

import { readdir, readFile, stat } from "node:fs/promises";
import { getSessionsDir } from "../paths.js";
import { parseKeyValueContent } from "../key-value.js";
import { isOrchestratorSession, type PortfolioProject } from "../types.js";
import {
  listPortfolioSessions,
  getPortfolioSessionCounts,
} from "../portfolio-session-service.js";

function makeProject(overrides: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: "test-project",
    name: "Test Project",
    configPath: "/tmp/config/agent-orchestrator.yaml",
    configProjectKey: "test-project",
    repoPath: "/tmp/project",
    sessionPrefix: "test",
    source: "config",
    enabled: true,
    pinned: false,
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("portfolio-session-service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getSessionsDir).mockReturnValue("/tmp/sessions");
    vi.mocked(isOrchestratorSession).mockReturnValue(false);
  });

  describe("listPortfolioSessions", () => {
    it("returns empty array for empty portfolio", async () => {
      const result = await listPortfolioSessions([]);
      expect(result).toEqual([]);
    });

    it("skips disabled projects", async () => {
      const project = makeProject({ enabled: false });
      const result = await listPortfolioSessions([project]);
      expect(result).toEqual([]);
      expect(readdir).not.toHaveBeenCalled();
    });

    it("skips degraded projects", async () => {
      const project = makeProject({ degraded: true });
      const result = await listPortfolioSessions([project]);
      expect(result).toEqual([]);
      expect(readdir).not.toHaveBeenCalled();
    });

    it("loads sessions from a valid project", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["session-1"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue(
        "status=working\nbranch=feat/test\ncreatedAt=2025-01-01T00:00:00Z",
      );
      vi.mocked(parseKeyValueContent).mockReturnValue({
        status: "working",
        branch: "feat/test",
        createdAt: "2025-01-01T00:00:00Z",
      });

      const result = await listPortfolioSessions([project]);
      expect(result).toHaveLength(1);
      expect(result[0].session.id).toBe("session-1");
      expect(result[0].session.status).toBe("working");
      expect(result[0].session.branch).toBe("feat/test");
      expect(result[0].project).toBe(project);
    });

    it("skips entries named 'archive' or starting with '.'", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["archive", ".hidden", "valid-session"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=working");
      vi.mocked(parseKeyValueContent).mockReturnValue({ status: "working" });

      const result = await listPortfolioSessions([project]);
      expect(result).toHaveLength(1);
      expect(result[0].session.id).toBe("valid-session");
    });

    it("skips entries with invalid session ID characters", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["valid-id", "invalid id!", "also/invalid"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=working");
      vi.mocked(parseKeyValueContent).mockReturnValue({ status: "working" });

      const result = await listPortfolioSessions([project]);
      expect(result).toHaveLength(1);
      expect(result[0].session.id).toBe("valid-id");
    });

    it("skips directories (non-files)", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["session-dir"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => false } as Awaited<ReturnType<typeof stat>>);

      const result = await listPortfolioSessions([project]);
      expect(result).toEqual([]);
    });

    it("skips orchestrator sessions", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["orch-session"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=working\nrole=orchestrator");
      vi.mocked(parseKeyValueContent).mockReturnValue({ status: "working", role: "orchestrator" });
      vi.mocked(isOrchestratorSession).mockReturnValue(true);

      const result = await listPortfolioSessions([project]);
      expect(result).toEqual([]);
    });

    it("returns empty when sessions dir does not exist", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));

      const result = await listPortfolioSessions([project]);
      expect(result).toEqual([]);
    });

    it("continues on per-file errors", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["bad-session", "good-session"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat)
        .mockRejectedValueOnce(new Error("EACCES"))
        .mockResolvedValueOnce({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=working");
      vi.mocked(parseKeyValueContent).mockReturnValue({ status: "working" });

      const result = await listPortfolioSessions([project]);
      expect(result).toHaveLength(1);
      expect(result[0].session.id).toBe("good-session");
    });

    it("constructs session with PR info when pr metadata present", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["sess-1"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=pr_open\npr=https://github.com/test/pr/1");
      vi.mocked(parseKeyValueContent).mockReturnValue({
        status: "pr_open",
        pr: "https://github.com/test/pr/1",
      });

      const result = await listPortfolioSessions([project]);
      expect(result[0].session.pr).not.toBeNull();
      expect(result[0].session.pr?.url).toBe("https://github.com/test/pr/1");
    });

    it("constructs session with agentInfo when summary present", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["sess-1"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=working\nsummary=Fix bug");
      vi.mocked(parseKeyValueContent).mockReturnValue({
        status: "working",
        summary: "Fix bug",
      });

      const result = await listPortfolioSessions([project]);
      expect(result[0].session.agentInfo).toEqual({
        summary: "Fix bug",
        agentSessionId: null,
      });
    });

    it("uses restoredAt as lastActivityAt when available and newer", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["sess-1"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue(
        "status=working\ncreatedAt=2025-01-01T00:00:00Z\nrestoredAt=2025-06-01T00:00:00Z",
      );
      vi.mocked(parseKeyValueContent).mockReturnValue({
        status: "working",
        createdAt: "2025-01-01T00:00:00Z",
        restoredAt: "2025-06-01T00:00:00Z",
      });

      const result = await listPortfolioSessions([project]);
      expect(result[0].session.lastActivityAt).toEqual(new Date("2025-06-01T00:00:00Z"));
    });

    it("times out slow projects", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([] as unknown as Awaited<ReturnType<typeof readdir>>), 5000)),
      );

      const result = await listPortfolioSessions([project], { perProjectTimeoutMs: 50 });
      expect(result).toEqual([]);
    });

    it("constructs session with runtimeHandle when runtimeHandle present", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["sess-1"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=working\nruntimeHandle=tmux-123");
      vi.mocked(parseKeyValueContent).mockReturnValue({
        status: "working",
        runtimeHandle: "tmux-123",
      });

      const result = await listPortfolioSessions([project]);
      expect(result[0].session.runtimeHandle).toEqual({
        id: "tmux-123",
        runtimeName: "tmux",
        data: {},
      });
    });
  });

  describe("getPortfolioSessionCounts", () => {
    it("returns zero counts for disabled projects", async () => {
      const project = makeProject({ enabled: false });
      const counts = await getPortfolioSessionCounts([project]);
      expect(counts[project.id]).toEqual({ total: 0, active: 0 });
    });

    it("returns zero counts for degraded projects", async () => {
      const project = makeProject({ degraded: true });
      const counts = await getPortfolioSessionCounts([project]);
      expect(counts[project.id]).toEqual({ total: 0, active: 0 });
    });

    it("returns zero counts when sessions dir does not exist", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockRejectedValue(new Error("ENOENT"));

      const counts = await getPortfolioSessionCounts([project]);
      expect(counts[project.id]).toEqual({ total: 0, active: 0 });
    });

    it("counts total and active sessions correctly", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["sess-1", "sess-2", "sess-3"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile)
        .mockResolvedValueOnce("status=working")
        .mockResolvedValueOnce("status=done")
        .mockResolvedValueOnce("status=pr_open");
      vi.mocked(parseKeyValueContent)
        .mockReturnValueOnce({ status: "working" })
        .mockReturnValueOnce({ status: "done" })
        .mockReturnValueOnce({ status: "pr_open" });

      const counts = await getPortfolioSessionCounts([project]);
      // total = 3 (all), active = 2 (working + pr_open, done is terminal)
      expect(counts[project.id]).toEqual({ total: 3, active: 2 });
    });

    it("skips archive and hidden entries in counts", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["archive", ".hidden", "sess-1"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=working");
      vi.mocked(parseKeyValueContent).mockReturnValue({ status: "working" });

      const counts = await getPortfolioSessionCounts([project]);
      expect(counts[project.id]).toEqual({ total: 1, active: 1 });
    });

    it("excludes orchestrator sessions from counts", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["orch", "worker"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=working");
      vi.mocked(parseKeyValueContent).mockReturnValue({ status: "working" });
      vi.mocked(isOrchestratorSession)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const counts = await getPortfolioSessionCounts([project]);
      expect(counts[project.id]).toEqual({ total: 1, active: 1 });
    });

    it("skips non-file entries in counts", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["subdir"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat).mockResolvedValue({ isFile: () => false } as Awaited<ReturnType<typeof stat>>);

      const counts = await getPortfolioSessionCounts([project]);
      expect(counts[project.id]).toEqual({ total: 0, active: 0 });
    });

    it("treats terminal statuses as inactive", async () => {
      const project = makeProject();
      const terminalStatuses = ["killed", "terminated", "done", "cleanup", "errored", "merged"];
      vi.mocked(readdir).mockResolvedValue(
        terminalStatuses.map((_, i) => `sess-${i}`) as unknown as Awaited<ReturnType<typeof readdir>>,
      );
      vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);

      for (let i = 0; i < terminalStatuses.length; i++) {
        vi.mocked(readFile).mockResolvedValueOnce(`status=${terminalStatuses[i]}`);
        vi.mocked(parseKeyValueContent).mockReturnValueOnce({ status: terminalStatuses[i] });
      }

      const counts = await getPortfolioSessionCounts([project]);
      expect(counts[project.id]).toEqual({ total: 6, active: 0 });
    });

    it("handles per-file errors gracefully in counts", async () => {
      const project = makeProject();
      vi.mocked(readdir).mockResolvedValue(["bad", "good"] as unknown as Awaited<ReturnType<typeof readdir>>);
      vi.mocked(stat)
        .mockRejectedValueOnce(new Error("EACCES"))
        .mockResolvedValueOnce({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
      vi.mocked(readFile).mockResolvedValue("status=working");
      vi.mocked(parseKeyValueContent).mockReturnValue({ status: "working" });

      const counts = await getPortfolioSessionCounts([project]);
      expect(counts[project.id]).toEqual({ total: 1, active: 1 });
    });

    it("handles outer try-catch for unexpected errors", async () => {
      const project = makeProject();
      vi.mocked(getSessionsDir).mockImplementation(() => {
        throw new Error("unexpected");
      });

      const counts = await getPortfolioSessionCounts([project]);
      expect(counts[project.id]).toEqual({ total: 0, active: 0 });
    });
  });
});
