import { describe, it, expect, vi } from "vitest";

vi.mock("@aoagents/ao-core/types", () => ({
  isOrchestratorSession: vi.fn((s: { id: string }) => s.id.startsWith("orch-")),
}));

import {
  filterProjectSessions,
  getProjectScopedHref,
  getProjectSessionHref,
  filterWorkerSessions,
} from "../project-utils";

type SessionLike = { id: string; projectId: string; metadata?: Record<string, string> };

describe("filterProjectSessions", () => {
  const projects = {
    "my-app": { sessionPrefix: "myapp-" },
    docs: {},
  };

  const sessions: SessionLike[] = [
    { id: "myapp-1", projectId: "my-app" },
    { id: "docs-1", projectId: "docs" },
    { id: "myapp-2", projectId: "my-app" },
  ];

  it("returns all sessions when filter is null", () => {
    expect(filterProjectSessions(sessions, null, projects)).toEqual(sessions);
  });

  it("returns all sessions when filter is 'all'", () => {
    expect(filterProjectSessions(sessions, "all", projects)).toEqual(sessions);
  });

  it("filters by projectId", () => {
    const result = filterProjectSessions(sessions, "docs", projects);
    expect(result).toEqual([{ id: "docs-1", projectId: "docs" }]);
  });

  it("matches by sessionPrefix", () => {
    const sessions: SessionLike[] = [
      { id: "myapp-1", projectId: "other" },
    ];
    const result = filterProjectSessions(sessions, "my-app", projects);
    expect(result).toHaveLength(1);
  });

  it("does not match similarly-prefixed sessions without a boundary", () => {
    const sessions: SessionLike[] = [{ id: "myappv2-1", projectId: "other" }];
    const result = filterProjectSessions(sessions, "my-app", projects);
    expect(result).toEqual([]);
  });
});

describe("getProjectScopedHref", () => {
  it("includes project param when projectId is set", () => {
    expect(getProjectScopedHref("/", "my-app")).toBe("/?project=my-app");
  });

  it("falls back to project=all when projectId is undefined", () => {
    expect(getProjectScopedHref("/", undefined)).toBe("/?project=all");
  });

  it("encodes special characters in projectId", () => {
    expect(getProjectScopedHref("/prs", "my app")).toBe("/prs?project=my%20app");
  });
});

describe("getProjectSessionHref", () => {
  it("returns correct path", () => {
    expect(getProjectSessionHref("my-app", "s-1")).toBe("/projects/my-app/sessions/s-1");
  });

  it("encodes special characters", () => {
    expect(getProjectSessionHref("my app", "s 1")).toBe("/projects/my%20app/sessions/s%201");
  });
});

describe("filterWorkerSessions", () => {
  const projects = { "my-app": {} };

  it("filters out orchestrator sessions", () => {
    const sessions: SessionLike[] = [
      { id: "orch-1", projectId: "my-app" },
      { id: "worker-1", projectId: "my-app" },
    ];
    const result = filterWorkerSessions(sessions, null, projects);
    expect(result).toEqual([{ id: "worker-1", projectId: "my-app" }]);
  });

  it("applies project filter after worker filter", () => {
    const sessions: SessionLike[] = [
      { id: "worker-1", projectId: "my-app" },
      { id: "worker-2", projectId: "other" },
    ];
    const result = filterWorkerSessions(sessions, "my-app", projects);
    expect(result).toEqual([{ id: "worker-1", projectId: "my-app" }]);
  });

  it("drops sessions for projects not present in the supplied project map", () => {
    const sessions: SessionLike[] = [
      { id: "worker-1", projectId: "my-app" },
      { id: "worker-2", projectId: "disabled" },
    ];

    const result = filterWorkerSessions(sessions, null, projects);
    expect(result).toEqual([{ id: "worker-1", projectId: "my-app" }]);
  });
});
