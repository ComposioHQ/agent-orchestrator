import { describe, expect, it, vi } from "vitest";
import { buildReactionMessage } from "../reaction-message.js";
import type { PRInfo, Runtime, SCM, Session } from "../types.js";

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/org/repo/pull/42",
    title: "Fix lifecycle reaction messages",
    owner: "org",
    repo: "repo",
    branch: "feat/reaction-msg",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "pr_open",
    activity: "active",
    branch: "feat/reaction-msg",
    issueId: "13",
    pr: makePR(),
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    lastActivityAt: new Date("2025-01-01T00:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

function makeRuntime(output: string): Runtime {
  return {
    name: "mock-runtime",
    create: vi.fn(),
    destroy: vi.fn(),
    sendMessage: vi.fn(),
    getOutput: vi.fn().mockResolvedValue(output),
    isAlive: vi.fn().mockResolvedValue(true),
  };
}

function makeSCM(overrides: Partial<SCM> = {}): SCM {
  return {
    name: "mock-scm",
    detectPR: vi.fn(),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn(),
    closePR: vi.fn(),
    getCIChecks: vi.fn().mockResolvedValue([]),
    getCISummary: vi.fn().mockResolvedValue("failing"),
    getReviews: vi.fn().mockResolvedValue([]),
    getReviewDecision: vi.fn().mockResolvedValue("none"),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getAutomatedComments: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn(),
    ...overrides,
  };
}

describe("buildReactionMessage", () => {
  it("builds context-rich CI message with checks, comments, and truncated output", async () => {
    const hugeOutput = Array.from(
      { length: 12 },
      (_, index) => `line-${index} ${"x".repeat(60)}`,
    ).join("\n");
    const runtime = makeRuntime(hugeOutput);

    const scm = makeSCM({
      getCIChecks: vi.fn().mockResolvedValue([
        {
          name: "unit-tests",
          status: "failed",
          url: "https://example.com/checks/1",
        },
        {
          name: "lint",
          status: "failed",
          url: "https://example.com/checks/2",
        },
      ]),
      getPendingComments: vi.fn().mockResolvedValue([
        {
          id: "c1",
          author: "reviewer",
          body: "Please split this function and add tests for edge cases.",
          path: "packages/core/src/lifecycle-manager.ts",
          line: 355,
          isResolved: false,
          createdAt: new Date("2025-01-01T00:00:00Z"),
          url: "https://example.com/review/1",
        },
      ]),
    });

    const message = await buildReactionMessage({
      reactionKey: "ci-failed",
      fallbackMessage: "CI is failing. Fix it.",
      session: makeSession(),
      scm,
      runtime,
    });

    expect(message).toContain("CI failed for PR #42");
    expect(message).toContain("Failing checks");
    expect(message).toContain("unit-tests");
    expect(message).toContain("Top unresolved review comments");
    expect(message).toContain("Recommended fix order");
    expect(message).toContain("Recent terminal output (truncated)");
    expect(message).toContain("...(truncated)");
  });

  it("builds context-rich changes-requested message with review excerpts", async () => {
    const scm = makeSCM({
      getCIChecks: vi.fn().mockResolvedValue([
        {
          name: "integration-tests",
          status: "failed",
          url: "https://example.com/checks/3",
        },
      ]),
      getPendingComments: vi.fn().mockResolvedValue([
        {
          id: "c2",
          author: "alice",
          body: "Can we simplify this control flow?\nIt is hard to follow.",
          path: "packages/core/src/session-manager.ts",
          line: 210,
          isResolved: false,
          createdAt: new Date("2025-01-02T00:00:00Z"),
          url: "https://example.com/review/2",
        },
      ]),
    });

    const message = await buildReactionMessage({
      reactionKey: "changes-requested",
      fallbackMessage: "Review comments found.",
      session: makeSession(),
      scm,
      runtime: makeRuntime(""),
    });

    expect(message).toContain("Changes requested on PR #42");
    expect(message).toContain("Unresolved review comments");
    expect(message).toContain("alice @ packages/core/src/session-manager.ts:210");
    expect(message).toContain("Still-failing CI checks");
    expect(message).toContain("Recommended fix order");
  });

  it("falls back to configured message when no contextual payload exists", async () => {
    const fallback = "CI is failing. Fix it.";
    const message = await buildReactionMessage({
      reactionKey: "ci-failed",
      fallbackMessage: fallback,
      session: makeSession(),
      scm: makeSCM(),
      runtime: makeRuntime(""),
    });

    expect(message).toBe(fallback);
  });

  it("builds automated-review message sorted by severity", async () => {
    const scm = makeSCM({
      getAutomatedComments: vi.fn().mockResolvedValue([
        {
          id: "b1",
          botName: "dependabot[bot]",
          body: "Warning: update this dependency.",
          path: "package.json",
          line: 14,
          severity: "warning",
          createdAt: new Date("2025-01-01T00:00:00Z"),
          url: "https://example.com/bot/1",
        },
        {
          id: "b2",
          botName: "codecov[bot]",
          body: "Potential issue in coverage thresholds.",
          path: "packages/core/src/lifecycle-manager.ts",
          line: 120,
          severity: "error",
          createdAt: new Date("2025-01-01T00:00:00Z"),
          url: "https://example.com/bot/2",
        },
      ]),
    });

    const message = await buildReactionMessage({
      reactionKey: "bugbot-comments",
      fallbackMessage: "Automated review comments found.",
      session: makeSession(),
      scm,
      runtime: makeRuntime(""),
    });

    const errorIndex = message.indexOf("[error] codecov[bot]");
    const warningIndex = message.indexOf("[warning] dependabot[bot]");
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeLessThan(warningIndex);
    expect(message).toContain("Recommended fix order");
  });
});
