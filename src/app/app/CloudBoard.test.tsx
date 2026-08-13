import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { CloudBoard } from "./CloudBoard";

const mocks = vi.hoisted(() => ({
  listSessionPullRequests: vi.fn(),
}));

vi.mock("@/lib/cloud-client", () => ({
  browserCloudClient: () => mocks,
}));

const session = {
  id: "session-1",
  orgId: "org-1",
  projectId: "project-1",
  kind: "worker" as const,
  harness: "codex",
  displayName: "Implement transport",
  branch: "feat/transport",
  mode: "standard" as const,
  deniedCommands: [],
  activityState: "idle" as const,
  status: "idle" as const,
  runtimeConnected: true,
  isTerminated: false,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

beforeEach(() => {
  mocks.listSessionPullRequests.mockReset();
  mocks.listSessionPullRequests.mockResolvedValue({
    sessionId: "session-1",
    pullRequests: [
      {
        url: "https://github.com/acme/api/pull/7",
        htmlUrl: "https://github.com/acme/api/pull/7",
        number: 7,
        title: "Fix the transport bug",
        state: "open",
        provider: "github",
        repository: "acme/api",
        author: "octocat",
        sourceBranch: "feat/transport",
        targetBranch: "main",
        headSha: "deadbeef",
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        ci: { state: "passing", failingChecks: [] },
        review: {
          decision: "none",
          hasUnresolvedHumanComments: false,
          unresolvedBy: [],
          reviews: [],
        },
        mergeability: {
          state: "mergeable",
          reasons: [],
          pullRequestUrl: "https://github.com/acme/api/pull/7",
          conflictFiles: [],
        },
        updatedAt: "2026-08-12T00:00:00Z",
        observedAt: "2026-08-12T00:00:00Z",
        ciObservedAt: "2026-08-12T00:00:00Z",
        reviewObservedAt: "2026-08-12T00:00:00Z",
      },
    ],
  });
});

it("shows a session's open pull requests as badges on its board card", async () => {
  render(
    <CloudBoard
      onSelectSession={vi.fn()}
      organizationId="org-1"
      sessions={[session]}
    />,
  );

  expect(mocks.listSessionPullRequests).toHaveBeenCalledWith(
    "org-1",
    "session-1",
  );
  expect(await screen.findByText("#7")).toBeVisible();
  expect(screen.getByText("Open")).toBeVisible();
});

it("renders an empty board without fetching pull requests", () => {
  render(
    <CloudBoard onSelectSession={vi.fn()} organizationId="org-1" sessions={[]} />,
  );

  expect(screen.getByText("No sessions yet")).toBeVisible();
  expect(mocks.listSessionPullRequests).not.toHaveBeenCalled();
});
