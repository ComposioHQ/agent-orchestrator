import { describe, expect, it } from "vitest";
import type { ProjectConfig, SCMWebhookEvent, Session } from "@aoagents/ao-core";
import { eventMatchesProject, findAffectedSessions } from "./scm-webhooks";

const project: ProjectConfig = {
  name: "my-app",
  repo: "acme/my-app",
  path: "/tmp/my-app",
  defaultBranch: "main",
  sessionPrefix: "my-app",
};

describe("eventMatchesProject", () => {
  it("matches when repository owner/name equals project repo", () => {
    const event: SCMWebhookEvent = {
      provider: "github",
      kind: "pull_request",
      action: "opened",
      rawEventType: "pull_request",
      repository: { owner: "acme", name: "my-app" },
      data: {},
    };

    expect(eventMatchesProject(event, project)).toBe(true);
  });

  it("matches repository names case-insensitively", () => {
    const event: SCMWebhookEvent = {
      provider: "github",
      kind: "pull_request",
      action: "opened",
      rawEventType: "pull_request",
      repository: { owner: "AcMe", name: "My-App" },
      data: {},
    };

    expect(eventMatchesProject(event, project)).toBe(true);
  });

  it("does not match when repository is missing", () => {
    const event: SCMWebhookEvent = {
      provider: "github",
      kind: "unknown",
      action: "noop",
      rawEventType: "unknown",
      data: {},
    };

    expect(eventMatchesProject(event, project)).toBe(false);
  });
});

describe("findAffectedSessions", () => {
  it("skips terminal sessions even when branch/pr match", () => {
    const sessions: Session[] = [
      {
        id: "s1",
        projectId: "my-app",
        status: "working",
        activity: "active",
        branch: "feat/one",
        issueId: null,
        pr: {
          number: 1,
          url: "u",
          title: "t",
          owner: "acme",
          repo: "my-app",
          branch: "feat/one",
          baseBranch: "main",
          isDraft: false,
        },
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      },
      {
        id: "s2",
        projectId: "my-app",
        status: "merged",
        activity: "exited",
        branch: "feat/one",
        issueId: null,
        pr: {
          number: 1,
          url: "u",
          title: "t",
          owner: "acme",
          repo: "my-app",
          branch: "feat/one",
          baseBranch: "main",
          isDraft: false,
        },
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      },
    ];

    const event: SCMWebhookEvent = {
      provider: "github",
      kind: "pull_request",
      action: "synchronize",
      rawEventType: "pull_request",
      prNumber: 1,
      data: {},
    };

    const affected = findAffectedSessions(sessions, "my-app", event);
    expect(affected.map((s) => s.id)).toEqual(["s1"]);
  });
});
