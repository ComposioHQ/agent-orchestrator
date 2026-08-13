import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { CloudSessionWorkspace } from "./CloudSessionWorkspace";

const mocks = vi.hoisted(() => ({
  getWorkspaceDiff: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
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
  expect(await screen.findByText("README.md")).toBeVisible();
  expect(screen.getByText("diff --git a/README.md b/README.md")).toBeVisible();
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
      session={{ ...session, runtimeConnected: false }}
    />,
  );

  expect(
    screen.getByText("Waiting for the isolated worker and agent terminal…"),
  ).toBeVisible();
  expect(screen.queryByText("Interactive agent terminal")).not.toBeInTheDocument();
});
