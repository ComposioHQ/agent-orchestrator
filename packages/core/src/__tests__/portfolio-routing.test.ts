import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../portfolio-session-service.js", () => ({
  listPortfolioSessions: vi.fn(),
}));

import { listPortfolioSessions } from "../portfolio-session-service.js";
import type { PortfolioProject, PortfolioSession, Session } from "../types.js";
import { createActivitySignal } from "../activity-signal.js";
import { createInitialCanonicalLifecycle } from "../lifecycle-state.js";
import {
  resolvePortfolioProject,
  resolvePortfolioSession,
  derivePortfolioProjectId,
} from "../portfolio-routing.js";

function makeProject(overrides: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: "proj-a",
    name: "Project A",
    configPath: "/tmp/config/agent-orchestrator.yaml",
    configProjectKey: "proj-a",
    repoPath: "/tmp/project-a",
    sessionPrefix: "proj-a",
    source: "config",
    enabled: true,
    pinned: false,
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSession(id: string, projectId: string): Session {
  const createdAt = new Date();
  return {
    id,
    projectId,
    status: "working",
    activity: null,
    activitySignal: createActivitySignal("unavailable"),
    lifecycle: createInitialCanonicalLifecycle("worker", createdAt),
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt,
    lastActivityAt: createdAt,
    metadata: {} as Record<string, string>,
  };
}

describe("portfolio-routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("resolvePortfolioProject", () => {
    it("finds a project by ID", () => {
      const a = makeProject({ id: "proj-a" });
      const b = makeProject({ id: "proj-b", name: "Project B" });
      expect(resolvePortfolioProject([a, b], "proj-b")).toBe(b);
    });

    it("returns undefined when project not found", () => {
      const a = makeProject({ id: "proj-a" });
      expect(resolvePortfolioProject([a], "nonexistent")).toBeUndefined();
    });

    it("returns undefined for empty portfolio", () => {
      expect(resolvePortfolioProject([], "anything")).toBeUndefined();
    });
  });

  describe("resolvePortfolioSession", () => {
    it("returns matching session", async () => {
      const project = makeProject({ id: "proj-a" });
      const session = makeSession("sess-1", "proj-a");
      const portfolioSession: PortfolioSession = { session, project };

      vi.mocked(listPortfolioSessions).mockResolvedValue([portfolioSession]);

      const result = await resolvePortfolioSession([project], "proj-a", "sess-1");
      expect(result).toBe(portfolioSession);
      expect(listPortfolioSessions).toHaveBeenCalledWith([project]);
    });

    it("returns undefined when project not in portfolio", async () => {
      const project = makeProject({ id: "proj-a" });
      const result = await resolvePortfolioSession([project], "nonexistent", "sess-1");
      expect(result).toBeUndefined();
      expect(listPortfolioSessions).not.toHaveBeenCalled();
    });

    it("returns undefined when session not found in project", async () => {
      const project = makeProject({ id: "proj-a" });
      vi.mocked(listPortfolioSessions).mockResolvedValue([]);

      const result = await resolvePortfolioSession([project], "proj-a", "nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("derivePortfolioProjectId", () => {
    it("returns the key as-is when no collision", () => {
      const existing = new Set<string>();
      expect(derivePortfolioProjectId("my-project", existing)).toBe("my-project");
    });

    it("appends -2 suffix on first collision", () => {
      const existing = new Set(["my-project"]);
      expect(derivePortfolioProjectId("my-project", existing)).toBe("my-project-2");
    });

    it("increments suffix until unique", () => {
      const existing = new Set(["proj", "proj-2", "proj-3"]);
      expect(derivePortfolioProjectId("proj", existing)).toBe("proj-4");
    });

    it("handles empty key", () => {
      const existing = new Set<string>();
      expect(derivePortfolioProjectId("", existing)).toBe("");
    });
  });
});
