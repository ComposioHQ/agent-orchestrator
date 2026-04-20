import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("node:https", () => ({ request: requestMock }));

import { create, manifest, resolveJiraConfig, extractDocumentText, mapJiraIssue } from "../src/index.js";
import type { ProjectConfig } from "@aoagents/ao-core";

const project: ProjectConfig = {
  name: "test",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: {
    plugin: "jira",
    projectKey: "APP",
  },
};

const sampleIssue = {
  id: "10001",
  key: "APP-123",
  fields: {
    summary: "Fix login flow",
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Users cannot sign in." }],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Repro on mobile" }] }] },
          ],
        },
      ],
    },
    labels: ["bug", "urgent"],
    assignee: { displayName: "Alice Doe", emailAddress: "alice@example.com" },
    priority: { name: "High" },
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
  },
};

function mockJiraResponse(body: unknown, statusCode = 200) {
  requestMock.mockImplementationOnce((url: URL | string, options: unknown, callback: (res: EventEmitter & { statusCode?: number; headers: Record<string, string> }) => void) => {
    const res = new EventEmitter() as EventEmitter & { statusCode?: number; headers: Record<string, string> };
    res.statusCode = statusCode;
    res.headers = {};

    queueMicrotask(() => {
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify(body)));
      res.emit("end");
    });

    const req = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number, handler: () => void) => void;
      end: () => void;
      destroy: (err?: Error) => void;
    };
    req.setTimeout = (_ms, _handler) => {};
    req.end = () => {};
    req.destroy = (err?: Error) => {
      if (err) req.emit("error", err);
    };
    return req;
  });
}

describe("tracker-jira plugin", () => {
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env["JIRA_BASE_URL"] = "https://acme.atlassian.net";
    process.env["JIRA_EMAIL"] = "jira-bot@acme.com";
    process.env["JIRA_API_TOKEN"] = "secret-token";
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it("exports the expected manifest", () => {
    expect(manifest).toMatchObject({
      name: "jira",
      slot: "tracker",
      version: "0.1.0",
    });
  });

  it("resolves config from tracker overrides and env", () => {
    const config = resolveJiraConfig({
      ...project,
      tracker: {
        plugin: "jira",
        projectKey: "APP",
        baseUrl: "https://custom.atlassian.net/",
        email: "owner@acme.com",
      },
    });

    expect(config).toEqual({
      baseUrl: "https://custom.atlassian.net",
      email: "owner@acme.com",
      apiToken: "secret-token",
      projectKey: "APP",
      jql: undefined,
    });
  });

  it("fails fast when auth config is missing", () => {
    delete process.env["JIRA_API_TOKEN"];
    expect(() => resolveJiraConfig(project)).toThrow("JIRA_API_TOKEN");
  });

  it("extracts text from Atlassian document format", () => {
    expect(extractDocumentText(sampleIssue.fields.description)).toContain("Users cannot sign in.");
    expect(extractDocumentText(sampleIssue.fields.description)).toContain("Repro on mobile");
  });

  it("maps Jira issues into AO Issue shape", () => {
    const issue = mapJiraIssue(sampleIssue, resolveJiraConfig(project));
    expect(issue).toEqual({
      id: "APP-123",
      title: "Fix login flow",
      description: expect.stringContaining("Users cannot sign in."),
      url: "https://acme.atlassian.net/browse/APP-123",
      state: "in_progress",
      labels: ["bug", "urgent"],
      assignee: "Alice Doe",
      priority: 2,
      branchName: "feat/app-123",
    });
  });

  it("fetches a single Jira issue", async () => {
    mockJiraResponse(sampleIssue);
    const tracker = create();

    const issue = await tracker.getIssue("app-123", project);

    expect(issue.id).toBe("APP-123");
    expect(requestMock).toHaveBeenCalledTimes(1);
    const [url, options] = requestMock.mock.calls[0] as [URL, { headers: Record<string, string> }];
    expect(String(url)).toContain("/rest/api/3/issue/APP-123");
    expect(options.headers.Authorization).toContain("Basic ");
  });

  it("lists Jira issues using projectKey-derived JQL", async () => {
    mockJiraResponse({ issues: [sampleIssue] });
    const tracker = create();

    const issues = await tracker.listIssues!({ state: "open", labels: ["bug"], limit: 10 }, project);

    expect(issues).toHaveLength(1);
    const [url] = requestMock.mock.calls[0] as [URL];
    expect(String(url)).toContain("/rest/api/3/search/jql?");
    expect(decodeURIComponent(String(url))).toContain('project = "APP"');
    expect(decodeURIComponent(String(url))).toContain('labels = "bug"');
    expect(decodeURIComponent(String(url))).toContain("statusCategory != Done");
  });

  it("respects explicit tracker.jql for listIssues", async () => {
    mockJiraResponse({ issues: [sampleIssue] });
    const tracker = create();

    await tracker.listIssues!(
      { state: "closed" },
      {
        ...project,
        tracker: {
          plugin: "jira",
          jql: "project = APP ORDER BY created DESC",
        },
      },
    );

    const [url] = requestMock.mock.calls[0] as [URL];
    expect(decodeURIComponent(String(url))).toContain("project = APP ORDER BY created DESC");
  });
});
