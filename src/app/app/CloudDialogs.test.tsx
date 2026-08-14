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
      githubUser={{
        status: "available",
        connection: { connected: false, installations: [] },
      }}
      onClose={vi.fn()}
      onCreateFromGitHub={vi.fn()}
      onCreateScratchProject={vi.fn()}
      onCreateStandalone={vi.fn()}
      onOpenProviderSettings={vi.fn()}
    />,
  );

  expect(
    screen.getByRole("button", { name: /Create a Project/ }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: /Create a Standalone Agent/ }),
  ).toBeEnabled();
  expect(screen.queryByLabelText("Project name")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));

  expect(screen.getByRole("button", { name: /From GitHub/ })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: /Start from scratch/ }),
  ).toBeEnabled();
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
      githubUser={{
        status: "available",
        connection: { connected: false, installations: [] },
      }}
      onClose={vi.fn()}
      onCreateFromGitHub={onCreateFromGitHub}
      onCreateScratchProject={vi.fn()}
      onCreateStandalone={vi.fn()}
      onOpenProviderSettings={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));
  fireEvent.click(screen.getByRole("button", { name: /From GitHub/ }));
  expect(
    screen.getByRole("option", { name: "acme/cloud · private" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Add project" }));

  await waitFor(() =>
    expect(onCreateFromGitHub).toHaveBeenCalledWith(repository, "claude-code"),
  );
});

it("creates a standalone agent from the enabled local form", async () => {
  const onCreateStandalone = vi.fn().mockResolvedValue(undefined);
  render(
    <NewProjectDialog
      github={{
        status: "unavailable",
        installations: [],
        repositories: [],
      }}
      githubUser={{
        status: "available",
        connection: { connected: false, installations: [] },
      }}
      onClose={vi.fn()}
      onCreateFromGitHub={vi.fn()}
      onCreateScratchProject={vi.fn()}
      onCreateStandalone={onCreateStandalone}
      onOpenProviderSettings={vi.fn()}
    />,
  );

  fireEvent.click(
    screen.getByRole("button", { name: /Create a Standalone Agent/ }),
  );
  fireEvent.change(screen.getByLabelText("Agent name"), {
    target: { value: "Local worker" },
  });
  fireEvent.change(screen.getByLabelText("Initial task (optional)"), {
    target: { value: "Inspect the workspace" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

  await waitFor(() =>
    expect(onCreateStandalone).toHaveBeenCalledWith({
      displayName: "Local worker",
      harness: "claude-code",
      prompt: "Inspect the workspace",
    }),
  );
});

it("creates a private GitHub-backed scratch project for the selected owner", async () => {
  const onCreateScratchProject = vi.fn().mockResolvedValue(undefined);
  render(
    <NewProjectDialog
      github={{
        status: "available",
        installations: [],
        repositories: [],
      }}
      githubUser={{
        status: "available",
        connection: {
          connected: true,
          login: "dev",
          installations: [
            {
              githubInstallationId: "9007199254740993",
              accountLogin: "acme",
              accountType: "Organization",
              repositorySelection: "all",
              canCreateRepository: true,
            },
          ],
        },
      }}
      onClose={vi.fn()}
      onCreateFromGitHub={vi.fn()}
      onCreateScratchProject={onCreateScratchProject}
      onCreateStandalone={vi.fn()}
      onOpenProviderSettings={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));
  fireEvent.click(screen.getByRole("button", { name: /Start from scratch/ }));
  fireEvent.change(screen.getByLabelText("Project name"), {
    target: { value: "New service" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^GitHub/ }));
  expect(screen.getByRole("option", { name: "acme · org" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));

  await waitFor(() =>
    expect(onCreateScratchProject).toHaveBeenCalledWith({
      displayName: "New service",
      harness: "claude-code",
      prompt: "",
      githubInstallationId: "9007199254740993",
      private: true,
      noRepository: undefined,
    }),
  );
});

it("flags a scratch project when no repository is selected", async () => {
  const onCreateScratchProject = vi.fn().mockResolvedValue(undefined);
  render(
    <NewProjectDialog
      github={{
        status: "unavailable",
        installations: [],
        repositories: [],
      }}
      githubUser={{
        status: "available",
        connection: { connected: false, installations: [] },
      }}
      onClose={vi.fn()}
      onCreateFromGitHub={vi.fn()}
      onCreateScratchProject={onCreateScratchProject}
      onCreateStandalone={vi.fn()}
      onOpenProviderSettings={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));
  fireEvent.click(screen.getByRole("button", { name: /Start from scratch/ }));
  fireEvent.change(screen.getByLabelText("Project name"), {
    target: { value: "Loose agents" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^No repository/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));

  await waitFor(() =>
    expect(onCreateScratchProject).toHaveBeenCalledWith({
      displayName: "Loose agents",
      harness: "claude-code",
      prompt: "",
      githubInstallationId: undefined,
      private: undefined,
      noRepository: true,
    }),
  );
});
