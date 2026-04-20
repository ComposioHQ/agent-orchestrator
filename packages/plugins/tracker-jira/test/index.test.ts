import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock("node:https", () => ({ request: requestMock }));

import { create, manifest, resolveJiraConfig, extractDocumentText, mapJiraIssue } from "../src/index.js";
import type { ProjectConfig } from "@aoagents/ao-core";

type MockRequest = EventEmitter & {
  setTimeout: (ms: number, handler: () => void) => void;
  end: () => void;
  destroy: (err?: Error) => void;
  write: ReturnType<typeof vi.fn>;
};

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
          content: [
            { type: "text", text: "Users cannot sign in." },
            { type: "hardBreak" },
            { type: "text", text: "Reset link also fails." },
          ],
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

function installJiraMock() {
  const responses: Array<{ body: unknown; statusCode?: number }> = [];

  requestMock.mockImplementation(
    (_url: URL | string, _options: unknown, callback: (res: EventEmitter & { statusCode?: number; headers: Record<string, string> }) => void) => {
      const response = responses.shift();
      if (!response) {
        throw new Error("No mock Jira response queued");
      }

      const req = new EventEmitter() as MockRequest;
      req.setTimeout = (_ms, _handler) => {};
      req.write = vi.fn();
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode?: number; headers: Record<string, string> };
        res.statusCode = response.statusCode ?? 200;
        res.headers = {};

        queueMicrotask(() => {
          callback(res);
          res.emit("data", Buffer.from(JSON.stringify(response.body)));
          res.emit("end");
        });
      };
      req.destroy = (err?: Error) => {
        if (err) req.emit("error", err);
      };
      return req;
    },
  );

  return {
    queue(body: unknown, statusCode = 200) {
      responses.push({ body, statusCode });
    },
  };
}

describe("tracker-jira plugin", () => {
  const env = { ...process.env };
  let jira: ReturnType<typeof installJiraMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    jira = installJiraMock();
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
        issueTypeName: "Bug",
      },
    });

    expect(config).toEqual({
      baseUrl: "https://custom.atlassian.net",
      email: "owner@acme.com",
      apiToken: "secret-token",
      projectKey: "APP",
      jql: undefined,
      issueTypeName: "Bug",
    });
  });

  it("fails fast when auth config is missing", () => {
    delete process.env["JIRA_API_TOKEN"];
    expect(() => resolveJiraConfig(project)).toThrow("JIRA_API_TOKEN");
  });

  it("extracts text from Atlassian document format, including hard breaks", () => {
    const text = extractDocumentText(sampleIssue.fields.description);
    expect(text).toContain("Users cannot sign in.\nReset link also fails.");
    expect(text).toContain("Repro on mobile");
  });

  it("maps Jira issues into AO Issue shape", () => {
    const issue = mapJiraIssue(sampleIssue, resolveJiraConfig(project));
    expect(issue).toEqual({
      id: "APP-123",
      title: "Fix login flow",
      description: expect.stringContaining("Users cannot sign in.\nReset link also fails."),
      url: "https://acme.atlassian.net/browse/APP-123",
      state: "in_progress",
      labels: ["bug", "urgent"],
      assignee: "Alice Doe",
      priority: 2,
      branchName: "feat/app-123",
    });
  });

  it("maps Jira 'Lowest' priority to AO low priority", () => {
    const issue = mapJiraIssue(
      {
        ...sampleIssue,
        key: "APP-124",
        fields: { ...sampleIssue.fields, priority: { name: "Lowest" } },
      },
      resolveJiraConfig(project),
    );

    expect(issue.priority).toBe(4);
  });

  it("fetches a single Jira issue", async () => {
    jira.queue(sampleIssue);
    const tracker = create();

    const issue = await tracker.getIssue("app-123", project);

    expect(issue.id).toBe("APP-123");
    expect(requestMock).toHaveBeenCalledTimes(1);
    const [url, options] = requestMock.mock.calls[0] as [URL, { headers: Record<string, string> }];
    expect(String(url)).toContain("/rest/api/3/issue/APP-123");
    expect(options.headers.Authorization).toContain("Basic ");
  });

  it("lists Jira issues using projectKey-derived JQL", async () => {
    jira.queue({ issues: [sampleIssue] });
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
    jira.queue({ issues: [sampleIssue] });
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

  it("updates state, labels, removes labels, and posts a comment", async () => {
    jira.queue({ transitions: [{ id: "31", to: { name: "Done", statusCategory: { key: "done" } } }] });
    jira.queue({});
    jira.queue(sampleIssue);
    jira.queue({});
    jira.queue({ id: "comment-1" });
    const tracker = create();

    await tracker.updateIssue!(
      "APP-123",
      {
        state: "closed",
        labels: ["verified", "agent:done"],
        removeLabels: ["urgent"],
        comment: "Verified on staging.",
      },
      project,
    );

    expect(requestMock).toHaveBeenCalledTimes(5);

    const transitionWrite = (requestMock.mock.results[1].value as MockRequest).write.mock.calls[0][0];
    expect(JSON.parse(transitionWrite)).toEqual({ transition: { id: "31" } });

    const issueUpdateWrite = (requestMock.mock.results[3].value as MockRequest).write.mock.calls[0][0];
    expect(JSON.parse(issueUpdateWrite)).toEqual({ fields: { labels: ["bug", "verified", "agent:done"] } });

    const commentWrite = (requestMock.mock.results[4].value as MockRequest).write.mock.calls[0][0];
    expect(JSON.parse(commentWrite).body.content[0].content[0].text).toBe("Verified on staging.");
  });

  it("creates an issue with priority, labels, assignee, and custom issue type", async () => {
    jira.queue([{ accountId: "acct-123", displayName: "Alice Doe" }]);
    jira.queue({ id: "10002", key: "APP-456" });
    jira.queue({
      ...sampleIssue,
      key: "APP-456",
      fields: {
        ...sampleIssue.fields,
        summary: "New login bug",
        labels: ["agent:backlog"],
        assignee: { displayName: "Alice Doe" },
        priority: { name: "Highest" },
      },
    });
    const tracker = create();

    const issue = await tracker.createIssue!(
      {
        title: "New login bug",
        description: "Freshly reported",
        labels: ["agent:backlog"],
        assignee: "Alice Doe",
        priority: 1,
      },
      {
        ...project,
        tracker: {
          plugin: "jira",
          projectKey: "APP",
          issueTypeName: "Bug",
        },
      },
    );

    expect(issue.id).toBe("APP-456");
    expect(requestMock).toHaveBeenCalledTimes(3);

    const createWrite = (requestMock.mock.results[1].value as MockRequest).write.mock.calls[0][0];
    const createBody = JSON.parse(createWrite);
    expect(createBody.fields.issuetype).toEqual({ name: "Bug" });
    expect(createBody.fields.priority).toEqual({ name: "Highest" });
    expect(createBody.fields.labels).toEqual(["agent:backlog"]);
    expect(createBody.fields.assignee).toEqual({ id: "acct-123" });
  });

  it("requires projectKey for createIssue", async () => {
    const tracker = create();
    await expect(
      tracker.createIssue!({ title: "Missing key", description: "" }, { ...project, tracker: { plugin: "jira" } }),
    ).rejects.toThrow("projectKey");
  });
});
