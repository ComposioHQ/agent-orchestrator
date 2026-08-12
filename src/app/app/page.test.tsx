import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { CloudWorkspace } from "./page";

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  listGitHubInstallations: vi.fn(),
  listGitHubRepositories: vi.fn(),
  getGitHubUserConnection: vi.fn(),
  listProviderConnections: vi.fn(),
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  createProject: vi.fn(),
  createSession: vi.fn(),
  createGitHubScratchProject: vi.fn(),
  startGitHubUserAuthorization: vi.fn(),
  disconnectGitHubUser: vi.fn(),
  putAgentProviderConnection: vi.fn(),
  deleteAgentProviderConnection: vi.fn(),
}));

vi.mock("@/lib/cloud-client", () => ({
  browserCloudClient: () => ({
    getCurrentAccount: mocks.getCurrentAccount,
    listGitHubInstallations: mocks.listGitHubInstallations,
    listGitHubRepositories: mocks.listGitHubRepositories,
    getGitHubUserConnection: mocks.getGitHubUserConnection,
    listProviderConnections: mocks.listProviderConnections,
    listProjects: mocks.listProjects,
    listSessions: mocks.listSessions,
    createProject: mocks.createProject,
    createSession: mocks.createSession,
    createGitHubScratchProject: mocks.createGitHubScratchProject,
    startGitHubUserAuthorization: mocks.startGitHubUserAuthorization,
    disconnectGitHubUser: mocks.disconnectGitHubUser,
    putAgentProviderConnection: mocks.putAgentProviderConnection,
    deleteAgentProviderConnection: mocks.deleteAgentProviderConnection,
  }),
  newIdempotencyKey: () => "test-key",
}));

beforeEach(() => {
  mocks.getCurrentAccount.mockResolvedValue({
    user: {
      id: "user-1",
      email: "dev@example.com",
      displayName: "Dev User",
      authProvider: "local",
    },
    organizations: [
      {
        id: "org-1",
        slug: "dev-team",
        displayName: "Dev Team",
        role: "owner",
      },
    ],
  });
  mocks.listProjects.mockResolvedValue({
    items: [
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
    ],
    page: { hasMore: false },
  });
  mocks.listSessions.mockResolvedValue({
    items: [
      {
        id: "session-1",
        orgId: "org-1",
        projectId: "project-1",
        kind: "worker",
        harness: "codex",
        displayName: "Build cloud authentication",
        branch: "feat/cloud-auth",
        mode: "standard",
        deniedCommands: [],
        activityState: "idle",
        status: "idle",
        runtimeConnected: false,
        isTerminated: false,
        createdAt: "2026-08-12T00:00:00Z",
        updatedAt: "2026-08-12T00:00:00Z",
      },
    ],
    page: { hasMore: false },
  });
  mocks.listGitHubInstallations.mockResolvedValue([]);
  mocks.listGitHubRepositories.mockResolvedValue({
    items: [],
    page: { hasMore: false },
  });
  mocks.getGitHubUserConnection.mockResolvedValue({
    connected: false,
    installations: [],
  });
  mocks.listProviderConnections.mockResolvedValue([]);
  mocks.createProject.mockResolvedValue({
    project: {
      id: "project-scratch",
      orgId: "org-1",
      displayName: "Local agent workspace",
      repositoryUrl: "https://scratch.ao.local/test",
      defaultBranch: "main",
      config: { scratch: true, standalone: true },
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:00Z",
    },
  });
  mocks.createSession.mockResolvedValue({
    session: {
      id: "session-scratch",
      orgId: "org-1",
      projectId: "project-scratch",
      kind: "worker",
      harness: "claude-code",
      displayName: "Local agent",
      branch: "main",
      mode: "standard",
      deniedCommands: [],
      activityState: "idle",
      status: "idle",
      runtimeConnected: false,
      isTerminated: false,
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:00Z",
    },
  });
  mocks.createGitHubScratchProject.mockResolvedValue({
    project: {
      id: "project-github-scratch",
      orgId: "org-1",
      displayName: "GitHub scratch",
      repositoryUrl: "https://github.com/acme/github-scratch",
      defaultBranch: "main",
      githubRepositoryId: "9007199254740993",
      config: { source: "scratch" },
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:00Z",
    },
    repository: {
      githubRepositoryId: "9007199254740993",
      name: "github-scratch",
      fullName: "acme/github-scratch",
      htmlUrl: "https://github.com/acme/github-scratch",
      defaultBranch: "main",
      visibility: "private",
      isPrivate: true,
      isArchived: false,
      access: "active",
      grantedAt: "2026-08-12T00:00:00Z",
    },
    session: {
      id: "session-github-scratch",
      orgId: "org-1",
      projectId: "project-github-scratch",
      kind: "orchestrator",
      harness: "claude-code",
      displayName: "GitHub scratch orchestrator",
      branch: "main",
      mode: "trusted",
      deniedCommands: [],
      activityState: "idle",
      status: "idle",
      runtimeConnected: false,
      isTerminated: false,
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:00Z",
    },
  });
  mocks.putAgentProviderConnection.mockResolvedValue({
    providerConnection: {
      id: "connection-1",
      provider: "claude-code",
      label: "default",
      config: { credentialType: "api_key" },
      validationState: "valid",
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:00Z",
    },
  });
  mocks.deleteAgentProviderConnection.mockResolvedValue(undefined);
});

it("loads real account, project, and session data into shared board views", async () => {
  render(<CloudWorkspace />);

  expect(await screen.findByText("Dev Team")).toBeVisible();
  expect(screen.getAllByText("Cloud platform").length).toBeGreaterThan(0);
  expect(
    screen.getAllByText("Build cloud authentication").length,
  ).toBeGreaterThan(0);
  expect(screen.getByTestId("board-session-card")).toBeVisible();
  expect(mocks.listProjects).toHaveBeenCalledWith("org-1", { limit: 100 });
});

it("does not expose the obsolete per-project worker button", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  expect(
    screen.queryByRole("button", { name: "New worker" }),
  ).not.toBeInTheDocument();
});

it("creates a standalone scratch project and worker session", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.click(
    screen.getByRole("button", { name: /Create a Standalone Agent/ }),
  );
  fireEvent.change(screen.getByLabelText("Agent name"), {
    target: { value: "Local agent" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

  await waitFor(() =>
    expect(mocks.createProject).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        displayName: "Local agent",
        repositoryUrl: expect.stringMatching(/^https:\/\/scratch\.ao\.local\//),
        config: {
          source: "standalone-agent",
          scratch: true,
          standalone: true,
        },
      }),
      { idempotencyKey: "test-key" },
    ),
  );
  expect(mocks.createSession).toHaveBeenCalledWith(
    "org-1",
    expect.objectContaining({
      projectId: "project-scratch",
      kind: "worker",
      harness: "claude-code",
      displayName: "Local agent",
      mode: "trusted",
    }),
    { idempotencyKey: "test-key" },
  );
  expect(screen.getByText("Standalone Agents")).toBeVisible();
});

it("searches the loaded workspace without demo commands", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const dialog = screen.getByRole("dialog", { name: "Search workspace" });
  fireEvent.change(within(dialog).getByLabelText("Search"), {
    target: { value: "authentication" },
  });

  expect(
    within(dialog).getByRole("button", {
      name: /Build cloud authentication/,
    }),
  ).toBeVisible();
  expect(within(dialog).queryByText("Open Settings")).not.toBeInTheDocument();
});

it("connects coding-agent credentials from provider settings", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));

  expect(screen.getByRole("heading", { name: "Organization" })).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Add organization" }),
  ).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Provider connections" }));
  expect(screen.getByText("No GitHub installation")).toBeVisible();
  fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]);
  fireEvent.change(screen.getByLabelText("Secret"), {
    target: { value: "sk-ant-test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(mocks.putAgentProviderConnection).toHaveBeenCalledWith(
      "org-1",
      "claude-code",
      { credentialType: "api_key", secret: "sk-ant-test" },
    ),
  );
});

it("opens project actions and presents sharing without a false create action", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Cloud platform" }),
  );
  expect(
    screen.getByRole("menuitem", { name: "Project settings" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Share project" }));

  const dialog = screen.getByRole("dialog", {
    name: "Share Cloud platform",
  });
  expect(
    within(dialog).getByRole("button", { name: "Create link" }),
  ).toBeDisabled();
});
