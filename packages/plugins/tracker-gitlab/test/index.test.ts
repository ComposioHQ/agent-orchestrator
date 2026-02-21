import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import nock from "nock";
import { create } from "../src/index.js";

describe("tracker-gitlab plugin", () => {
  const token = "test-token";
  const project = { repo: "group/project" };
  const iid = 42;

  beforeEach(() => {
    vi.resetAllMocks();
    nock.cleanAll();
    process.env["GITLAB_TOKEN"] = token;
  });

  afterEach(() => {
    delete process.env["GITLAB_TOKEN"];
    nock.cleanAll();
  });

  it("getIssue maps fields correctly", async () => {
    const api = nock("https://gitlab.com")
      .get(`/api/v4/projects/${encodeURIComponent(project.repo)}/issues/${iid}`)
      .reply(200, {
        id: 1001,
        iid,
        title: "Test issue",
        description: "Body here",
        state: "opened",
        labels: ["bug"],
        assignees: [{ id: 2, username: "alice", name: "Alice" }],
        web_url: `https://gitlab.com/${project.repo}/-/issues/${iid}`,
      });

    const tracker = create();
    const issue = await tracker.getIssue(String(iid), project as any);
    expect(issue.title).toBe("Test issue");
    expect(issue.id).toBe(String(iid));
    expect(issue.state).toBe("open");
    expect(issue.labels).toContain("bug");
    expect(issue.assignee).toBe("alice");
    api.done();
  });

  it("isCompleted returns true for closed state", async () => {
    nock("https://gitlab.com")
      .get(`/api/v4/projects/${encodeURIComponent(project.repo)}/issues/${iid}`)
      .reply(200, { iid, state: "closed" });

    const tracker = create();
    const done = await tracker.isCompleted(String(iid), project as any);
    expect(done).toBe(true);
  });
});