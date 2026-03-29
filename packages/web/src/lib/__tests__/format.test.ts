/**
 * Tests for session title heuristic and branch humanization.
 */

import { describe, it, expect } from "vitest";
import {
  humanizeBranch,
  getSessionTitle,
  getSessionSidebarLabel,
  isNumericIssueLabel,
  stripBranchHashPrefix,
} from "../format";
import type { DashboardSession } from "../types";

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function makeSession(overrides?: Partial<DashboardSession>): DashboardSession {
  return {
    id: "ao-42",
    projectId: "test",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: null,
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// stripBranchHashPrefix
// ---------------------------------------------------------------------------

describe("stripBranchHashPrefix", () => {
  it("removes leading hash run and trims", () => {
    expect(stripBranchHashPrefix("#feat/foo")).toBe("feat/foo");
    expect(stripBranchHashPrefix("##main")).toBe("main");
    expect(stripBranchHashPrefix("  #issue-12  ")).toBe("issue-12");
  });

  it("leaves names without a hash unchanged (aside from trim)", () => {
    expect(stripBranchHashPrefix("feat/bar")).toBe("feat/bar");
  });
});

// ---------------------------------------------------------------------------
// humanizeBranch
// ---------------------------------------------------------------------------

describe("humanizeBranch", () => {
  it("strips leading # before humanizing", () => {
    expect(humanizeBranch("#feat/infer-project-id")).toBe("Infer Project Id");
  });

  it("strips common prefixes and title-cases", () => {
    expect(humanizeBranch("feat/infer-project-id")).toBe("Infer Project Id");
    expect(humanizeBranch("fix/broken-auth-flow")).toBe("Broken Auth Flow");
    expect(humanizeBranch("chore/update-deps")).toBe("Update Deps");
    expect(humanizeBranch("refactor/session-manager")).toBe("Session Manager");
    expect(humanizeBranch("docs/add-readme")).toBe("Add Readme");
    expect(humanizeBranch("test/add-coverage")).toBe("Add Coverage");
    expect(humanizeBranch("ci/fix-pipeline")).toBe("Fix Pipeline");
  });

  it("strips additional prefixes added for completeness", () => {
    expect(humanizeBranch("release/1.0.0")).toBe("1.0.0");
    expect(humanizeBranch("hotfix/urgent-patch")).toBe("Urgent Patch");
    expect(humanizeBranch("feature/new-dashboard")).toBe("New Dashboard");
    expect(humanizeBranch("bugfix/null-pointer")).toBe("Null Pointer");
    expect(humanizeBranch("build/docker-image")).toBe("Docker Image");
    expect(humanizeBranch("wip/experimental")).toBe("Experimental");
    expect(humanizeBranch("improvement/faster-queries")).toBe("Faster Queries");
  });

  it("handles session/ prefix", () => {
    expect(humanizeBranch("session/ao-52")).toBe("Ao 52");
  });

  it("handles underscores", () => {
    expect(humanizeBranch("feat/add_new_feature")).toBe("Add New Feature");
  });

  it("handles branch with no prefix", () => {
    expect(humanizeBranch("main")).toBe("Main");
    expect(humanizeBranch("some-branch-name")).toBe("Some Branch Name");
  });

  it("handles branch with dots", () => {
    expect(humanizeBranch("release/v2.1.0")).toBe("V2.1.0");
  });

  it("handles empty string", () => {
    expect(humanizeBranch("")).toBe("");
  });

  it("does not strip unknown prefixes", () => {
    expect(humanizeBranch("custom/my-branch")).toBe("Custom/My Branch");
  });
});

// ---------------------------------------------------------------------------
// getSessionTitle — full fallback chain
// ---------------------------------------------------------------------------

describe("getSessionTitle", () => {
  it("returns PR title when available (highest priority)", () => {
    const session = makeSession({
      summary: "Agent summary",
      issueTitle: "Issue title",
      branch: "feat/branch",
      pr: {
        number: 1,
        url: "https://github.com/test/repo/pull/1",
        title: "feat: add auth",
        owner: "test",
        repo: "repo",
        branch: "feat/branch",
        baseBranch: "main",
        isDraft: false,
        state: "open",
        additions: 10,
        deletions: 5,
        ciStatus: "passing",
        ciChecks: [],
        reviewDecision: "approved",
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
        unresolvedThreads: 0,
        unresolvedComments: [],
      },
    });
    expect(getSessionTitle(session)).toBe("feat: add auth");
  });

  it("returns agent summary over issue title", () => {
    const session = makeSession({
      summary: "Implementing OAuth2 authentication with JWT tokens",
      summaryIsFallback: false,
      issueTitle: "Add user authentication",
      branch: "feat/auth",
    });
    expect(getSessionTitle(session)).toBe(
      "Implementing OAuth2 authentication with JWT tokens",
    );
  });

  it("skips fallback summaries in favor of issue title", () => {
    const session = makeSession({
      summary: "You are working on GitHub issue #42: Add authentication to API...",
      summaryIsFallback: true,
      issueTitle: "Add authentication to API",
      branch: "feat/issue-42",
    });
    expect(getSessionTitle(session)).toBe("Add authentication to API");
  });

  it("uses fallback summary when no issue title is available", () => {
    const session = makeSession({
      summary: "You are working on GitHub issue #42: Add authentication to API...",
      summaryIsFallback: true,
      issueTitle: null,
      branch: "feat/issue-42",
    });
    expect(getSessionTitle(session)).toBe(
      "You are working on GitHub issue #42: Add authentication to API...",
    );
  });

  it("returns issue title when no summary exists", () => {
    const session = makeSession({
      summary: null,
      issueTitle: "Add user authentication",
      branch: "feat/auth",
    });
    expect(getSessionTitle(session)).toBe("Add user authentication");
  });

  it("returns humanized branch when no summary or issue title", () => {
    const session = makeSession({
      summary: null,
      issueTitle: null,
      branch: "feat/infer-project-id",
    });
    expect(getSessionTitle(session)).toBe("Infer Project Id");
  });

  it("returns status as absolute last resort", () => {
    const session = makeSession({
      summary: null,
      issueTitle: null,
      branch: null,
    });
    expect(getSessionTitle(session)).toBe("working");
  });

  it("prefers fallback summary over branch when no issue title", () => {
    const session = makeSession({
      summary: "You are working on Linear ticket INT-1327: Refactor session manager",
      summaryIsFallback: true,
      issueTitle: null,
      branch: "feat/INT-1327",
    });
    expect(getSessionTitle(session)).toBe(
      "You are working on Linear ticket INT-1327: Refactor session manager",
    );
  });
});

// ---------------------------------------------------------------------------
// isNumericIssueLabel
// ---------------------------------------------------------------------------

describe("isNumericIssueLabel", () => {
  it("detects GitHub-style numeric labels", () => {
    expect(isNumericIssueLabel("#42")).toBe(true);
    expect(isNumericIssueLabel("7")).toBe(true);
    expect(isNumericIssueLabel("  #99  ")).toBe(true);
  });

  it("rejects slug and alphanumeric tracker ids", () => {
    expect(isNumericIssueLabel("INT-1327")).toBe(false);
    expect(isNumericIssueLabel("fix-killed-toggle")).toBe(false);
    expect(isNumericIssueLabel(null)).toBe(false);
    expect(isNumericIssueLabel("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSessionSidebarLabel
// ---------------------------------------------------------------------------

describe("getSessionSidebarLabel", () => {
  it("prefers issueTitle over issueLabel and summary", () => {
    const session = makeSession({
      issueTitle: "Fix auth bug",
      issueLabel: "#99",
      summary: "You are an AI assistant…",
      branch: "feat/auth",
    });
    expect(getSessionSidebarLabel(session)).toBe("Fix auth bug");
  });

  it("uses issueLabel when title missing (numeric or slug)", () => {
    expect(
      getSessionSidebarLabel(
        makeSession({ issueTitle: null, issueLabel: "fix-toggle", summary: "Session end" }),
      ),
    ).toBe("fix-toggle");
    expect(
      getSessionSidebarLabel(makeSession({ issueTitle: null, issueLabel: "#3", summary: "noise" })),
    ).toBe("#3");
  });

  it("uses humanized branch when no issue fields", () => {
    const session = makeSession({
      issueTitle: null,
      issueLabel: null,
      summary: "Session end",
      branch: "feat/infer-project-id",
    });
    expect(getSessionSidebarLabel(session)).toBe("Infer Project Id");
  });

  it("never uses summary", () => {
    const session = makeSession({
      issueTitle: null,
      issueLabel: null,
      summary: "You are an AI coding assistant",
      summaryIsFallback: false,
      branch: null,
    });
    expect(getSessionSidebarLabel(session)).toBe("ao-42");
  });

  it("humanizes branch after stripping leading #", () => {
    const session = makeSession({
      issueTitle: null,
      issueLabel: null,
      branch: "#feat/my-feature",
    });
    expect(getSessionSidebarLabel(session)).toBe("My Feature");
  });
});
