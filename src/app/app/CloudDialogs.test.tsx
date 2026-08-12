import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { NewProjectDialog } from "./CloudDialogs";

it("starts project creation with the two reference choices", () => {
  render(
    <NewProjectDialog
      github={{
        status: "unavailable",
        installations: [],
        repositories: [],
      }}
      onClose={vi.fn()}
      onCreateFromGitHub={vi.fn()}
      onOpenProviderSettings={vi.fn()}
    />,
  );

  expect(
    screen.getByRole("button", { name: /Create a Project/ }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: /Create a Standalone Agent/ }),
  ).toBeDisabled();
  expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));

  expect(screen.getByRole("button", { name: /From GitHub/ })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: /Start from scratch/ }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Use repository URL" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Back" })).toBeVisible();
});

it("imports an active repository through the GitHub project route", async () => {
  const repository = {
    githubRepositoryId: "9007199254740993",
    name: "cloud",
    fullName: "acme/cloud",
    htmlUrl: "https://github.com/acme/cloud",
    defaultBranch: "main",
    visibility: "private",
    isPrivate: true,
    isArchived: false,
    access: "active" as const,
    grantedAt: "2026-08-12T00:00:00Z",
  };
  const onCreateFromGitHub = vi.fn().mockResolvedValue(undefined);
  render(
    <NewProjectDialog
      github={{
        status: "available",
        installations: [],
        repositories: [repository],
      }}
      onClose={vi.fn()}
      onCreateFromGitHub={onCreateFromGitHub}
      onOpenProviderSettings={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));
  fireEvent.click(screen.getByRole("button", { name: /From GitHub/ }));
  expect(screen.getByRole("option", { name: "acme/cloud · private" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Add project" }));

  await waitFor(() => expect(onCreateFromGitHub).toHaveBeenCalledWith(repository));
});
