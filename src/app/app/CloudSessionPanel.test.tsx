import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { CloudSessionPanel } from "./CloudSessionPanel";

const mocks = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  readWorkspaceFile: vi.fn(),
  replayEvents: vi.fn(),
  sendMessage: vi.fn(),
  streamEvents: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}));

vi.mock("@/lib/cloud-client", () => ({
  browserCloudClient: () => ({
    listWorkspaceFiles: mocks.listWorkspaceFiles,
    readWorkspaceFile: mocks.readWorkspaceFile,
    replayEvents: mocks.replayEvents,
    sendMessage: mocks.sendMessage,
    streamEvents: mocks.streamEvents,
  }),
  newIdempotencyKey: () => "message-key",
  writeWorkspaceFile: mocks.writeWorkspaceFile,
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
  mocks.replayEvents.mockResolvedValue({
    events: [],
    hasMore: false,
    nextAfter: 0,
  });
  mocks.streamEvents.mockImplementation(async function* () {});
  mocks.sendMessage.mockResolvedValue({ event: {} });
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
    page: { hasMore: false },
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

it("sends turns only through a connected worker session", async () => {
  render(
    <CloudSessionPanel
      onClose={vi.fn()}
      organizationId="org-1"
      session={session}
    />,
  );
  const message = screen.getByLabelText("Message");
  fireEvent.change(message, { target: { value: "Continue the task" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "org-1",
      "session-1",
      "Continue the task",
      { idempotencyKey: "message-key" },
    ),
  );
});

it("lists, reads, and writes files while keeping terminal visibly unavailable", async () => {
  render(
    <CloudSessionPanel
      onClose={vi.fn()}
      organizationId="org-1"
      session={session}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Terminal unavailable" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  expect(await screen.findByText("README.md")).toBeVisible();
  fireEvent.click(screen.getByText("README.md"));
  const editor = await screen.findByLabelText("Edit README.md");
  fireEvent.change(editor, { target: { value: "updated\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(mocks.writeWorkspaceFile).toHaveBeenCalledWith(
      "org-1",
      "session-1",
      "README.md",
      "updated\n",
    ),
  );
});

it("keeps execution actions disabled while the worker is disconnected", () => {
  render(
    <CloudSessionPanel
      onClose={vi.fn()}
      organizationId="org-1"
      session={{ ...session, runtimeConnected: false }}
    />,
  );
  expect(screen.getByLabelText("Message")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Files" })).toBeDisabled();
});
