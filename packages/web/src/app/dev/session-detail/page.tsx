"use client";

import { SessionDetail } from "@/components/SessionDetail";
import type { DashboardSession } from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";

export const dynamic = "force-dynamic";

const projects: ProjectInfo[] = [
  { id: "vinesight-rn", name: "vinesight-rn", sessionPrefix: "vinesight-rn" },
  { id: "agent-orchestrator", name: "agent-orchestrator", sessionPrefix: "agent-orchestrator" },
  { id: "composio-sdk", name: "composio-sdk", sessionPrefix: "composio-sdk" },
];

const sidebarSessions: DashboardSession[] = [
  {
    id: "vinesight-rn-worker-1",
    projectId: "vinesight-rn",
    status: "working",
    activity: "active",
    branch: "fix/auth-token-refresh",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: "Fix auth token refresh",
    summary: "Fix auth token refresh",
    summaryIsFallback: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
  },
  {
    id: "backend-3",
    projectId: "vinesight-rn",
    status: "ci_failed",
    activity: "active",
    branch: "feat/dark-mode-tokens",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: "Add dark mode tokens",
    summary: "Add dark mode support to design system tokens",
    summaryIsFallback: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: {
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      title: "Add dark mode support to design system tokens",
      owner: "acme",
      repo: "app",
      branch: "feat/dark-mode-tokens",
      baseBranch: "main",
      isDraft: false,
      state: "open",
      additions: 234,
      deletions: 18,
      changedFiles: 6,
      ciStatus: "failing",
      ciChecks: [
        { name: "typecheck", status: "failed" },
        { name: "tests", status: "failed" },
        { name: "lint", status: "passed" },
        { name: "build", status: "passed" },
      ],
      reviewDecision: "changes_requested",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["CI failing", "Changes requested"],
      },
      unresolvedThreads: 3,
      unresolvedComments: [
        {
          url: "https://github.com/acme/app/pull/42#discussion_r1",
          path: "packages/web/src/theme/tokens.ts:42",
          author: "@sarah",
          body: "### Missing fallback for system preference\n<!-- DESCRIPTION START -->The dark mode toggle doesn't fall back to prefers-color-scheme. Users without a preference get stuck on light mode.<!-- DESCRIPTION END -->",
        },
        {
          url: "https://github.com/acme/app/pull/42#discussion_r2",
          path: "packages/web/src/theme/colors.ts:18",
          author: "@alex",
          body: "### Color contrast ratio too low\n<!-- DESCRIPTION START -->Secondary text in dark mode (#78716c) has 3.2:1 contrast. WCAG AA requires 4.5:1.<!-- DESCRIPTION END -->",
        },
        {
          url: "https://github.com/acme/app/pull/42#discussion_r3",
          path: "packages/web/src/app/globals.css:156",
          author: "@sarah",
          body: "### Unused CSS custom properties\n<!-- DESCRIPTION START -->Old light-mode-only custom properties are still defined but unreferenced. Clean up to avoid confusion.<!-- DESCRIPTION END -->",
        },
      ],
      enriched: true,
    },
    metadata: {
      lastCIFailureDispatchHash: "ci-notified",
      lastPendingReviewDispatchHash: "review-notified",
    },
  },
  {
    id: "vinesight-rn-worker-2",
    projectId: "vinesight-rn",
    status: "review_pending",
    activity: "idle",
    branch: "refactor/api-client",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: "Refactor API client",
    summary: "Refactor API client",
    summaryIsFallback: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 130).toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
  },
  {
    id: "vinesight-rn-worker-3",
    projectId: "vinesight-rn",
    status: "mergeable",
    activity: "ready",
    branch: "fix/memory-leak",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: "Fix memory leak",
    summary: "Fix memory leak",
    summaryIsFallback: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 240).toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
  },
  {
    id: "agent-orchestrator-worker-1",
    projectId: "agent-orchestrator",
    status: "mergeable",
    activity: "ready",
    branch: "design/review-fixes",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: "Design review fixes",
    summary: "Design review fixes",
    summaryIsFallback: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 75).toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
  },
  {
    id: "agent-orchestrator-worker-2",
    projectId: "agent-orchestrator",
    status: "needs_input",
    activity: "waiting_input",
    branch: "perf/reduce-bundle-size",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: "Reduce bundle size",
    summary: "Reduce bundle size",
    summaryIsFallback: false,
    createdAt: new Date(Date.now() - 1000 * 60 * 105).toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
  },
];

const currentSession = sidebarSessions[1] ?? sidebarSessions[0];

export default function SessionDetailDevPage() {
  if (!currentSession) {
    return null;
  }

  return (
    <SessionDetail
      session={currentSession}
      projects={projects}
      sidebarSessions={sidebarSessions}
      projectOrchestratorId="vinesight-rn-orchestrator"
    />
  );
}
