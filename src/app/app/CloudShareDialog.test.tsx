import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { CloudShareDialog } from "./CloudShareDialog";

const project = {
  id: "project-1",
  orgId: "org-1",
  displayName: "Cloud platform",
  repositoryUrl: "https://github.com/acme/cloud",
  defaultBranch: "main",
  config: {},
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

const session = {
  id: "session-1",
  orgId: "org-1",
  projectId: "project-1",
  kind: "worker" as const,
  harness: "claude-code",
  displayName: "Fix authentication",
  branch: "feat/auth",
  mode: "standard" as const,
  deniedCommands: [],
  activityState: "idle" as const,
  status: "idle" as const,
  runtimeConnected: false,
  isTerminated: false,
  createdAt: "2026-08-12T00:00:00Z",
  updatedAt: "2026-08-12T00:00:00Z",
};

it("shows reference sharing policy while disabling unavailable link creation", () => {
  render(
    <CloudShareDialog
      onClose={vi.fn()}
      project={project}
      sessions={[session]}
    />,
  );

  expect(screen.getByRole("radio", { name: /Viewer/ })).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: /Editor/ }));
  expect(screen.getByRole("radio", { name: /Editor/ })).toBeChecked();
  expect(screen.getByLabelText("Access for Fix authentication")).toBeVisible();
  expect(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  expect(
    screen.getByText(/Sharing routes are not implemented/),
  ).toBeVisible();
});
