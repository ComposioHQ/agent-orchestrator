import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { NewProjectDialog, NewSessionDialog } from "./CloudDialogs";

it("starts project creation with the two reference choices", () => {
  render(
    <NewProjectDialog onClose={vi.fn()} onCreate={vi.fn()} />,
  );

  expect(
    screen.getByRole("button", { name: /Create a Project/ }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: /Create a Standalone Agent/ }),
  ).toBeDisabled();
  expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));

  expect(screen.getByLabelText("Project name")).toBeVisible();
  expect(screen.getByRole("button", { name: "Back" })).toBeVisible();
});

it("uses the selected project and safe defaults for a cloud worker", async () => {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(
    <NewSessionDialog
      onClose={vi.fn()}
      onCreate={onCreate}
      projects={[
        {
          id: "project-1",
          orgId: "org-1",
          displayName: "Cloud platform",
          repositoryUrl: "https://github.com/acme/cloud",
          defaultBranch: "main",
          config: {},
          createdAt: "2026-08-12T00:00:00Z",
          updatedAt: "2026-08-12T00:00:00Z",
        },
      ]}
      selectedProjectId="project-1"
    />,
  );

  expect(screen.getByText("Cloud platform")).toBeVisible();
  expect(screen.queryByLabelText("Type")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Security mode")).not.toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Worker name"), {
    target: { value: "Fix authentication" },
  });
  fireEvent.change(screen.getByLabelText("Initial prompt"), {
    target: { value: "Repair the callback flow." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create worker" }));

  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      projectId: "project-1",
      kind: "worker",
      harness: "claude-code",
      displayName: "Fix authentication",
      prompt: "Repair the callback flow.",
      mode: "standard",
      deniedCommands: [],
    }),
  );
});
