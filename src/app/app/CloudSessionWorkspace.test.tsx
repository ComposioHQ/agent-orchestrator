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
  expect(mocks.getWorkspaceDiff).not.toHaveBeenCalled();
  expect(mocks.listSessionPullRequests).not.toHaveBeenCalled();
  expect(mocks.getSessionReviewState).not.toHaveBeenCalled();

  fireEvent.click(await screen.findByRole("tab", { name: "Summary" }));
  expect(await screen.findByText("diff --git a/README.md b/README.md")).toBeVisible();
  expect(mocks.listSessionPullRequests).toHaveBeenCalledWith("org-1", "session-1");
  expect(mocks.getSessionReviewState).toHaveBeenCalledWith("org-1", "session-1");

  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(await screen.findByText("README.md")).toBeVisible();
});

it("does not poll workspace diff or files while the inspector is open", async () => {
  const intervalSpy = vi.spyOn(window, "setInterval");

  render(
    <CloudSessionWorkspace
      onClose={vi.fn()} onDelete={vi.fn()} onNewTask={vi.fn()} onShare={vi.fn()}
      organizationId="org-1"
      session={session}
    />,
  );

  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(await screen.findByText("README.md")).toBeVisible();
  expect(intervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 2_000);
  expect(intervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 5_000);

  intervalSpy.mockRestore();
});

it("opens and edits repository files in the right inspector", async () => {
  render(
    <CloudSessionWorkspace
      onClose={vi.fn()} onDelete={vi.fn()} onNewTask={vi.fn()} onShare={vi.fn()}
      organizationId="org-1"
      session={session}
    />,
  );

  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
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

  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(screen.getByText("Interactive agent terminal")).toBeVisible();
  expect(screen.getByText("Interactive workspace terminal")).toBeVisible();
});

it("shows orchestrator and child worker changes in the orchestrator inspector", async () => {
  const orchestrator = {
    ...session,
    id: "orchestrator-1",
    kind: "orchestrator" as const,
    displayName: "Orchestrator",
  };
  const worker = {
    ...session,
    id: "worker-1",
    displayName: "random-file-pr",
  };
  mocks.getWorkspaceDiff.mockImplementation(async (_orgID: string, sessionID: string) => ({
    status: sessionID === worker.id ? "?? worker-fact.txt" : "?? random-fact.txt",
    unstaged: "",
    staged: "",
    combined: "",
    diffBaseRef: "main",
    files: [],
    untrackedFiles: sessionID === worker.id ? ["worker-fact.txt"] : ["random-fact.txt"],
    truncated: { combined: false, stats: false },
  }));
  mocks.readWorkspaceFile.mockResolvedValue({
    path: "random-fact.txt",
    content: "Honey never spoils.\n",
    size: 20,
  });

  render(
    <CloudSessionWorkspace
      onClose={vi.fn()}
      organizationId="org-1"
      projectSessions={[orchestrator, worker]}
      session={orchestrator}
    />,
  );

  fireEvent.click(await screen.findByRole("tab", { name: "Summary" }));
  expect((await screen.findAllByText("Orchestrator")).length).toBeGreaterThanOrEqual(1);
  expect(await screen.findByText("random-file-pr")).toBeVisible();
  fireEvent.click(screen.getByText("random-fact.txt"));
  await waitFor(() => expect(mocks.readWorkspaceFile).toHaveBeenCalledWith(
    "org-1",
    "orchestrator-1",
    "random-fact.txt",
  ));
  expect(mocks.getWorkspaceDiff).toHaveBeenCalledWith("org-1", "orchestrator-1");
  expect(mocks.getWorkspaceDiff).toHaveBeenCalledWith("org-1", "worker-1");
});

it("mounts visible terminals to wake a paused or provisioning worker", () => {
  render(
    <CloudSessionWorkspace
      onClose={vi.fn()} onDelete={vi.fn()} onNewTask={vi.fn()} onShare={vi.fn()}
      organizationId="org-1"
      session={{ ...session, runtimeConnected: false, runtimeState: "provisioning" }}
    />,
  );

  expect(screen.getByText("Interactive agent terminal")).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  expect(screen.getByText("Interactive workspace terminal")).toBeVisible();
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

  fireEvent.click(await screen.findByRole("tab", { name: "Summary" }));

  expect(await screen.findByText("#7 Fix the transport bug")).toBeVisible();
  expect(screen.getByText("Failing")).toBeVisible();
  expect(screen.getByText("Conflicts")).toBeVisible();
  expect(
    screen.getByText("Please add a test for the retry path."),
  ).toBeVisible();
});
