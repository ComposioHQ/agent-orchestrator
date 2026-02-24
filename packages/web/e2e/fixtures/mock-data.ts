import type {
  DashboardSession,
  DashboardPR,
  DashboardStats,
} from "../../src/lib/types.js";

/** Create a minimal mock session with overrides (JSON-serializable for API responses) */
export function makeSession(
  overrides: Partial<DashboardSession> = {},
): DashboardSession {
  return {
    id: "test-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: "Test session",
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
  };
}

/** Create a minimal mock PR with overrides */
export function makePR(overrides: Partial<DashboardPR> = {}): DashboardPR {
  return {
    number: 100,
    url: "https://github.com/acme/app/pull/100",
    title: "feat: test PR",
    owner: "acme",
    repo: "app",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    state: "open",
    additions: 50,
    deletions: 10,
    ciStatus: "passing",
    ciChecks: [
      { name: "build", status: "passed" },
      { name: "test", status: "passed" },
    ],
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
    ...overrides,
  };
}

function makeStats(sessions: DashboardSession[]): DashboardStats {
  return {
    totalSessions: sessions.length,
    workingSessions: sessions.filter((s) => s.activity === "active").length,
    openPRs: sessions.filter((s) => s.pr?.state === "open").length,
    needsReview: 0,
  };
}

/** Pre-built scenarios for common test states */
export const scenarios = {
  emptyDashboard: {
    sessions: [] as DashboardSession[],
    stats: {
      totalSessions: 0,
      workingSessions: 0,
      openPRs: 0,
      needsReview: 0,
    } satisfies DashboardStats,
  },

  activeDashboard: (() => {
    const sessions: DashboardSession[] = [
      makeSession({
        id: "backend-1",
        status: "working",
        activity: "active",
        summary: "Implementing auth flow",
      }),
      makeSession({
        id: "backend-2",
        status: "mergeable",
        activity: "idle",
        pr: makePR({
          number: 42,
          title: "feat: health check endpoint",
          state: "open",
        }),
      }),
      makeSession({
        id: "frontend-1",
        status: "ci_failed",
        activity: "idle",
        pr: makePR({
          number: 43,
          title: "fix: responsive layout",
          ciStatus: "failing",
          ciChecks: [{ name: "test", status: "failed" }],
          mergeability: {
            mergeable: false,
            ciPassing: false,
            approved: true,
            noConflicts: true,
            blockers: [],
          },
        }),
      }),
      makeSession({
        id: "backend-3",
        status: "needs_input",
        activity: "waiting_input",
        summary: "Waiting for API key",
      }),
      makeSession({
        id: "frontend-2",
        status: "killed",
        activity: "exited",
        summary: "Completed task",
      }),
    ];
    return { sessions, stats: makeStats(sessions) };
  })(),
};
