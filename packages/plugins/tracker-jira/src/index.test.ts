import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { manifest, create } from "./index.js";

describe("tracker-jira", () => {
  const project = {
    name: "app",
    repo: "org/app",
    path: "/tmp/app",
    defaultBranch: "main",
    sessionPrefix: "app",
    tracker: {
      plugin: "jira",
      baseUrl: "https://jira.example.com",
      email: "dev@example.com",
      apiToken: "token",
      projectKey: 'ENG" OR "a"="a',
    },
  };

  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has manifest metadata", () => {
    expect(manifest.name).toBe("jira");
    expect(manifest.slot).toBe("tracker");
  });

  it("creates tracker", () => {
    const tracker = create();
    expect(tracker.name).toBe("jira");
  });

  it("escapes projectKey in JQL query", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ issues: [] }),
    });

    const tracker = create();
    await tracker.listIssues!({}, project as any);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    const parsed = new URL(calledUrl);
    const jql = parsed.searchParams.get("jql");
    expect(jql).toContain('project = "ENG\\" OR \\"a\\"=\\"a"');
  });

  it("uses complete/finished transitions when closing issue", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        transitions: [
          { id: "1", name: "In Progress" },
          { id: "2", name: "Completed" },
        ],
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => ({}),
      text: async () => "",
    });

    const tracker = create();
    await tracker.updateIssue!("ENG-1", { state: "closed" }, project as any);

    const transitionCallBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(transitionCallBody).toEqual({ transition: { id: "2" } });
  });

  it("posts Jira comments as ADF document", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({}),
    });

    const tracker = create();
    await tracker.updateIssue!("ENG-2", { comment: "Looks good" }, project as any);

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toEqual({
      body: {
        version: 1,
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }],
      },
    });
  });
});
