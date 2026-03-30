import { describe, it, expect, vi } from "vitest";
import type {
  OrchestratorConfig,
  PluginRegistry,
  ProjectConfig,
  SCMWebhookEvent,
  Session,
} from "@composio/ao-core";

vi.mock("@composio/ao-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@composio/ao-core");
  return {
    ...actual,
    TERMINAL_STATUSES: new Set(["merged", "killed", "cleanup", "done", "terminated"]),
  };
});

import {
  findWebhookProjects,
  eventMatchesProject,
  findAffectedSessions,
  buildWebhookRequest,
} from "@/lib/scm-webhooks";

// ── findWebhookProjects ─────────────────────────────────────────────

describe("findWebhookProjects", () => {
  function makeConfig(projects: Record<string, Partial<ProjectConfig>>): OrchestratorConfig {
    return { projects } as unknown as OrchestratorConfig;
  }

  function makeRegistry(scmResult: unknown = null): PluginRegistry {
    return {
      get: vi.fn().mockReturnValue(scmResult),
    } as unknown as PluginRegistry;
  }

  it("returns matching project when webhook path matches pathname", () => {
    const config = makeConfig({
      "my-project": {
        scm: {
          plugin: "github",
          webhook: { enabled: true, path: "/api/webhooks/github" },
        },
        repo: "owner/repo",
      } as unknown as ProjectConfig,
    });

    const scm = { parseWebhook: vi.fn(), verifyWebhook: vi.fn() };
    const registry = makeRegistry(scm);

    const matches = findWebhookProjects(config, registry, "/api/webhooks/github");
    expect(matches).toHaveLength(1);
    expect(matches[0].projectId).toBe("my-project");
    expect(matches[0].scm).toBe(scm);
  });

  it("returns empty array when pathname does not match", () => {
    const config = makeConfig({
      "my-project": {
        scm: {
          plugin: "github",
          webhook: { enabled: true, path: "/api/webhooks/github" },
        },
        repo: "owner/repo",
      } as unknown as ProjectConfig,
    });

    const scm = { parseWebhook: vi.fn(), verifyWebhook: vi.fn() };
    const registry = makeRegistry(scm);

    const matches = findWebhookProjects(config, registry, "/api/webhooks/gitlab");
    expect(matches).toHaveLength(0);
  });

  it("returns empty array when webhook is disabled", () => {
    const config = makeConfig({
      "my-project": {
        scm: {
          plugin: "github",
          webhook: { enabled: false, path: "/api/webhooks/github" },
        },
        repo: "owner/repo",
      } as unknown as ProjectConfig,
    });

    const registry = makeRegistry({ parseWebhook: vi.fn(), verifyWebhook: vi.fn() });
    const matches = findWebhookProjects(config, registry, "/api/webhooks/github");
    expect(matches).toHaveLength(0);
  });

  it("returns empty array when project has no scm config", () => {
    const config = makeConfig({
      "my-project": { repo: "owner/repo" } as unknown as ProjectConfig,
    });

    const registry = makeRegistry();
    const matches = findWebhookProjects(config, registry, "/api/webhooks/github");
    expect(matches).toHaveLength(0);
  });

  it("returns empty array when scm plugin lacks parseWebhook or verifyWebhook", () => {
    const config = makeConfig({
      "my-project": {
        scm: {
          plugin: "github",
          webhook: { enabled: true, path: "/api/webhooks/github" },
        },
        repo: "owner/repo",
      } as unknown as ProjectConfig,
    });

    // SCM plugin without parseWebhook
    const registry = makeRegistry({ verifyWebhook: vi.fn() });
    const matches = findWebhookProjects(config, registry, "/api/webhooks/github");
    expect(matches).toHaveLength(0);
  });

  it("uses default webhook path when path is not specified", () => {
    const config = makeConfig({
      "my-project": {
        scm: {
          plugin: "github",
          webhook: { enabled: true },
        },
        repo: "owner/repo",
      } as unknown as ProjectConfig,
    });

    const scm = { parseWebhook: vi.fn(), verifyWebhook: vi.fn() };
    const registry = makeRegistry(scm);

    const matches = findWebhookProjects(config, registry, "/api/webhooks/github");
    expect(matches).toHaveLength(1);
  });

  it("matches multiple projects with the same webhook path", () => {
    const config = makeConfig({
      "project-a": {
        scm: {
          plugin: "github",
          webhook: { enabled: true, path: "/api/webhooks/github" },
        },
        repo: "owner/repo-a",
      } as unknown as ProjectConfig,
      "project-b": {
        scm: {
          plugin: "github",
          webhook: { enabled: true, path: "/api/webhooks/github" },
        },
        repo: "owner/repo-b",
      } as unknown as ProjectConfig,
    });

    const scm = { parseWebhook: vi.fn(), verifyWebhook: vi.fn() };
    const registry = makeRegistry(scm);

    const matches = findWebhookProjects(config, registry, "/api/webhooks/github");
    expect(matches).toHaveLength(2);
  });
});

// ── eventMatchesProject ─────────────────────────────────────────────

describe("eventMatchesProject", () => {
  it("returns true when repository matches project repo (case insensitive)", () => {
    const event: SCMWebhookEvent = {
      repository: { owner: "Acme", name: "App" },
    } as unknown as SCMWebhookEvent;
    const project = { repo: "acme/app" } as unknown as ProjectConfig;

    expect(eventMatchesProject(event, project)).toBe(true);
  });

  it("returns false when repository does not match", () => {
    const event: SCMWebhookEvent = {
      repository: { owner: "acme", name: "other" },
    } as unknown as SCMWebhookEvent;
    const project = { repo: "acme/app" } as unknown as ProjectConfig;

    expect(eventMatchesProject(event, project)).toBe(false);
  });

  it("returns false when event has no repository", () => {
    const event = {} as unknown as SCMWebhookEvent;
    const project = { repo: "acme/app" } as unknown as ProjectConfig;

    expect(eventMatchesProject(event, project)).toBe(false);
  });

  it("matches case insensitively on project side too", () => {
    const event: SCMWebhookEvent = {
      repository: { owner: "acme", name: "app" },
    } as unknown as SCMWebhookEvent;
    const project = { repo: "ACME/APP" } as unknown as ProjectConfig;

    expect(eventMatchesProject(event, project)).toBe(true);
  });
});

// ── findAffectedSessions ────────────────────────────────────────────

describe("findAffectedSessions", () => {
  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: "session-1",
      projectId: "my-project",
      status: "working",
      branch: "feat/test",
      pr: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      ...overrides,
    } as Session;
  }

  it("matches sessions by PR number", () => {
    const sessions = [
      makeSession({ id: "s1", pr: { number: 42 } as Session["pr"] }),
      makeSession({ id: "s2", pr: { number: 99 } as Session["pr"] }),
    ];
    const event = { prNumber: 42 } as unknown as SCMWebhookEvent;

    const result = findAffectedSessions(sessions, "my-project", event);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  it("matches sessions by branch name", () => {
    const sessions = [
      makeSession({ id: "s1", branch: "feat/auth" }),
      makeSession({ id: "s2", branch: "feat/other" }),
    ];
    const event = { branch: "feat/auth" } as unknown as SCMWebhookEvent;

    const result = findAffectedSessions(sessions, "my-project", event);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  it("filters out sessions in terminal statuses", () => {
    const sessions = [
      makeSession({ id: "s1", status: "merged", branch: "feat/auth" }),
      makeSession({ id: "s2", status: "working", branch: "feat/auth" }),
    ];
    const event = { branch: "feat/auth" } as unknown as SCMWebhookEvent;

    const result = findAffectedSessions(sessions, "my-project", event);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s2");
  });

  it("filters out sessions from different projects", () => {
    const sessions = [
      makeSession({ id: "s1", projectId: "other-project", branch: "feat/auth" }),
      makeSession({ id: "s2", projectId: "my-project", branch: "feat/auth" }),
    ];
    const event = { branch: "feat/auth" } as unknown as SCMWebhookEvent;

    const result = findAffectedSessions(sessions, "my-project", event);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s2");
  });

  it("returns empty array when no sessions match", () => {
    const sessions = [makeSession({ id: "s1", branch: "main" })];
    const event = { branch: "feat/auth" } as unknown as SCMWebhookEvent;

    const result = findAffectedSessions(sessions, "my-project", event);
    expect(result).toHaveLength(0);
  });

  it("returns empty array for event with no branch or PR number", () => {
    const sessions = [makeSession({ id: "s1", branch: "feat/auth" })];
    const event = {} as unknown as SCMWebhookEvent;

    const result = findAffectedSessions(sessions, "my-project", event);
    expect(result).toHaveLength(0);
  });

  it("filters out all known terminal statuses", () => {
    const terminalStatuses = ["merged", "killed", "cleanup", "done", "terminated"];
    const sessions = terminalStatuses.map((status, i) =>
      makeSession({ id: `s${i}`, status, branch: "feat/auth" }),
    );
    const event = { branch: "feat/auth" } as unknown as SCMWebhookEvent;

    const result = findAffectedSessions(sessions, "my-project", event);
    expect(result).toHaveLength(0);
  });
});

// ── buildWebhookRequest ─────────────────────────────────────────────

describe("buildWebhookRequest", () => {
  it("converts Request to SCMWebhookRequest", () => {
    const request = new Request("https://example.com/api/webhooks/github?foo=bar", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature": "sha256=abc" },
    });
    const body = '{"action":"opened"}';
    const rawBody = new TextEncoder().encode(body);

    const result = buildWebhookRequest(request, body, rawBody);

    expect(result.method).toBe("POST");
    expect(result.path).toBe("/api/webhooks/github");
    expect(result.query).toEqual({ foo: "bar" });
    expect(result.body).toBe(body);
    expect(result.rawBody).toBe(rawBody);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.headers["x-hub-signature"]).toBe("sha256=abc");
  });

  it("handles request with no query parameters", () => {
    const request = new Request("https://example.com/api/webhooks/github", {
      method: "POST",
    });
    const body = "{}";
    const rawBody = new TextEncoder().encode(body);

    const result = buildWebhookRequest(request, body, rawBody);

    expect(result.query).toEqual({});
    expect(result.path).toBe("/api/webhooks/github");
  });

  it("converts all headers to a plain record", () => {
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      headers: {
        "x-custom-1": "value1",
        "x-custom-2": "value2",
      },
    });

    const result = buildWebhookRequest(request, "", new Uint8Array());

    expect(result.headers["x-custom-1"]).toBe("value1");
    expect(result.headers["x-custom-2"]).toBe("value2");
  });
});
