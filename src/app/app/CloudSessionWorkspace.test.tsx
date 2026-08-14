import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { CloudSessionWorkspace } from "./CloudSessionWorkspace";

const mocks = vi.hoisted(() => ({
  getWorkspaceDiff: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  listSessionPullRequests: vi.fn(),
  getSessionReviewState: vi.fn(),
}));

vi.mock("@/lib/cloud-client", () => ({
  browserCloudClient: () => mocks,
}));
vi.mock("./CloudTerminal", () => ({
  CloudTerminal: ({ kind }: { kind: string }) => (
    <div>Interactive {kind} terminal</div>
  ),
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
  mocks.getWorkspaceDiff.mockResolvedValue({
    status: " M README.md",
    unstaged: "diff --git a/README.md b/README.md",
    staged: "",
    combined: "diff --git a/README.md b/README.md",
    diffBaseRef: "main",
    files: [
      {
        path: "README.md",
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
      },
    ],
    untrackedFiles: [],
    truncated: { combined: false, stats: false },
  });
  mocks.listWorkspaceFiles.mockResolvedValue({
    path: "",
    items: [
      {
        name: "README.md",
        path: "README.md",
        isDir: false,
        size: 6,
        mode: "-rw-------",
        modTime: "2026-08-12T00:00:00Z",
      },
    ],
    hasMore: false,
  });
  mocks.readWorkspaceFile.mockResolvedValue({
    path: "README.md",
    content: "hello\n",
    size: 6,
  });
  mocks.writeWorkspaceFile.mockResolvedValue({
    path: "README.md",
    content: "updated\n",
    size: 8,
  });
  mocks.listSessionPullRequests.mockResolvedValue({
    sessionId: "session-1",
    pullRequests: [],
  });
  mocks.getSessionReviewState.mockResolvedValue({
    sessionId: "session-1",
    reviews: [],
    runs: [],
  });
});

it("uses the interactive agent terminal as the primary session surface", async () => {
  render(
    <CloudSessionWorkspace
      onClose={vi.fn()} onDelete={vi.fn()} onNewTask={vi.fn()} onShare={vi.fn()}
      organizationId="org-1"
      session={session}
    />,
  );

  expect(screen.getByText("Interactive agent terminal")).toBeVisible();
  expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();

  fireEvent.click(await screen.findByRole("button", { name: "Changes 1" }));
  expect(await screen.findByText("diff --git a/README.md b/README.md")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  expect(await screen.findByText("README.md")).toBeVisible();
});

it("opens and edits repository files in the right inspector", async () => {
  render(
    <CloudSessionWorkspace
      onClose={vi.fn()} onDelete={vi.fn()} onNewTask={vi.fn()} onShare={vi.fn()}
      organizationId="org-1"
      session={session}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  fireEvent.click(await screen.findByText("README.md"));
  const editor = await screen.findByLabelText("Edit README.md");
  fireEvent.change(editor, { target: { value: "updated\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(mocks.writeWorkspaceFile).toHaveBeenCalledWith(
      "org-1",
      "session-1",
      { path: "README.md", content: "updated\n" },
    ),
  );
});

it("opens a separate trusted workspace shell in the right inspector", () => {
  render(
    <CloudSessionWorkspace
      onClose={vi.fn()} onDelete={vi.fn()} onNewTask={vi.fn()} onShare={vi.fn()}
      organizationId="org-1"
      session={{ ...session, mode: "trusted" }}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
  expect(screen.getByText("Interactive agent terminal")).toBeVisible();
  expect(screen.getByText("Interactive workspace terminal")).toBeVisible();
});

it("waits for the worker before mounting the terminal", () => {
  render(
    <CloudSessionWorkspace
      onClose={vi.fn()} onDelete={vi.fn()} onNewTask={vi.fn()} onShare={vi.fn()}
      organizationId="org-1"
      session={{ ...session, runtimeConnected: false, runtimeState: "provisioning" }}
    />,
  );

  expect(
    screen.getByText("Provisioning the NodeOps VM…"),
  ).toBeVisible();
  expect(screen.queryByText("Interactive agent terminal")).not.toBeInTheDocument();
});

it("shows the worker failure instead of looping on a waiting message", () => {
  render(
    <CloudSessionWorkspace
      onClose={vi.fn()} onDelete={vi.fn()} onNewTask={vi.fn()} onShare={vi.fn()}
      organizationId="org-1"
      session={{
        ...session,
        mode: "trusted",
        runtimeConnected: false,
        runtimeState: "failed",
        runtimeError: "NodeOps could not start the requested rootfs.",
      }}
    />,
  );

  expect(screen.getAllByText("NodeOps could not start the requested rootfs.")).toHaveLength(2);
  expect(screen.queryByText("Interactive agent terminal")).not.toBeInTheDocument();
  expect(screen.queryByText("Interactive workspace terminal")).not.toBeInTheDocument();
});

it("shows a pull request's status and AO's review verdict in the pull requests tab", async () => {
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
        ci: { state: "failing", failingChecks: [] },
        review: {
          decision: "changes_requested",
          hasUnresolvedHumanComments: false,
          unresolvedBy: [],
          reviews: [],
        },
        mergeability: {
          state: "conflicting",
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
  mocks.getSessionReviewState.mockResolvedValue({
    sessionId: "session-1",
    reviews: [
      {
        pullRequestUrl: "https://github.com/acme/api/pull/7",
        pullRequestNumber: 7,
        title: "Fix the transport bug",
        targetSha: "deadbeef",
        status: "changes_requested",
        latestRun: {
          id: "run-1",
          reviewId: "run-1",
          sessionId: "session-1",
          batchId: "",
          harness: "codex",
          pullRequestUrl: "https://github.com/acme/api/pull/7",
          targetSha: "deadbeef",
          status: "delivered",
          verdict: "changes_requested",
          body: "Please add a test for the retry path.",
          providerReviewId: "999",
          createdAt: "2026-08-12T00:00:00Z",
          deliveredAt: "2026-08-12T00:01:00Z",
          autoInjectReview: false,
        },
      },
    ],
    runs: [],
  });

  render(
    <CloudSessionWorkspace
      onClose={vi.fn()}
      organizationId="org-1"
      session={session}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Pull requests 1" }));

  expect(await screen.findByText("#7 Fix the transport bug")).toBeVisible();
  expect(screen.getByText("Failing")).toBeVisible();
  expect(screen.getByText("Conflicts")).toBeVisible();
  expect(
    screen.getByText("Please add a test for the retry path."),
  ).toBeVisible();
});
