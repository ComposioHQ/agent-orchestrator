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
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  createGitHubScratchProject: vi.fn(),
  startGitHubUserAuthorization: vi.fn(),
  disconnectGitHubUser: vi.fn(),
  putAgentProviderConnection: vi.fn(),
  deleteAgentProviderConnection: vi.fn(),
  listUserProviderConnections: vi.fn(),
  putUserProviderConnection: vi.fn(),
  deleteUserProviderConnection: vi.fn(),
  listOrgMembers: vi.fn(),
  listOrgInvitations: vi.fn(),
  createOrgInvitation: vi.fn(),
  revokeOrgInvitation: vi.fn(),
  listProjectShareLinks: vi.fn(),
  createProjectShareLink: vi.fn(),
  revokeProjectShareLink: vi.fn(),
  listProjectShareGrants: vi.fn(),
  revokeProjectShareGrant: vi.fn(),
  redeemProjectShareLink: vi.fn(),
  listSharedProjects: vi.fn(),
  listSharedProjectSessions: vi.fn(),
  getSession: vi.fn(),
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
    updateProject: mocks.updateProject,
    deleteProject: mocks.deleteProject,
    createSession: mocks.createSession,
    deleteSession: mocks.deleteSession,
    createGitHubScratchProject: mocks.createGitHubScratchProject,
    startGitHubUserAuthorization: mocks.startGitHubUserAuthorization,
    disconnectGitHubUser: mocks.disconnectGitHubUser,
    putAgentProviderConnection: mocks.putAgentProviderConnection,
    deleteAgentProviderConnection: mocks.deleteAgentProviderConnection,
    listUserProviderConnections: mocks.listUserProviderConnections,
    putUserProviderConnection: mocks.putUserProviderConnection,
    deleteUserProviderConnection: mocks.deleteUserProviderConnection,
    listOrgMembers: mocks.listOrgMembers,
    listOrgInvitations: mocks.listOrgInvitations,
    createOrgInvitation: mocks.createOrgInvitation,
    revokeOrgInvitation: mocks.revokeOrgInvitation,
    listProjectShareLinks: mocks.listProjectShareLinks,
    createProjectShareLink: mocks.createProjectShareLink,
    revokeProjectShareLink: mocks.revokeProjectShareLink,
    listProjectShareGrants: mocks.listProjectShareGrants,
    revokeProjectShareGrant: mocks.revokeProjectShareGrant,
    redeemProjectShareLink: mocks.redeemProjectShareLink,
    listSharedProjects: mocks.listSharedProjects,
    listSharedProjectSessions: mocks.listSharedProjectSessions,
    getSession: mocks.getSession,
  }),
  consumePendingShareRedemption: () => null,
  newIdempotencyKey: () => "test-key",
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json(
        { authenticated: true },
        { headers: { "Cache-Control": "no-store" } },
      ),
    ),
  );
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
  mocks.updateProject.mockResolvedValue({
    project: {
      id: "project-1",
      orgId: "org-1",
      displayName: "Cloud API",
      repositoryUrl: "https://github.com/acme/cloud",
      defaultBranch: "develop",
      config: {},
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T01:00:00Z",
    },
  });
  mocks.deleteProject.mockResolvedValue({
    project: { id: "project-1", deleted: true },
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
  mocks.deleteSession.mockResolvedValue({
    session: { id: "session-1", desiredState: "deleted" },
  });
  mocks.listProviderConnections.mockResolvedValue([]);
  mocks.listUserProviderConnections.mockResolvedValue([]);
  mocks.listOrgMembers.mockResolvedValue([]);
  mocks.listOrgInvitations.mockResolvedValue([]);
  mocks.listProjectShareLinks.mockResolvedValue([]);
  mocks.listProjectShareGrants.mockResolvedValue([]);
  mocks.listSharedProjects.mockResolvedValue([]);
  mocks.listSharedProjectSessions.mockResolvedValue([]);
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

it("shows one search result per standalone agent", async () => {
  mocks.listProjects.mockResolvedValue({
    items: [
      {
        id: "standalone-project",
        orgId: "org-1",
        displayName: "Solo agent",
        repositoryUrl: "https://scratch.ao.local/solo",
        defaultBranch: "main",
        config: {
          source: "standalone-agent",
          scratch: true,
          standalone: true,
        },
        createdAt: "2026-08-12T00:00:00Z",
        updatedAt: "2026-08-12T00:00:00Z",
      },
    ],
    page: { hasMore: false },
  });
  mocks.listSessions.mockResolvedValue({
    items: [
      {
        id: "standalone-session",
        orgId: "org-1",
        projectId: "standalone-project",
        kind: "worker",
        harness: "claude-code",
        displayName: "Solo agent",
        branch: "main",
        mode: "trusted",
        deniedCommands: [],
        activityState: "idle",
        status: "idle",
        runtimeConnected: true,
        isTerminated: false,
        createdAt: "2026-08-12T00:00:00Z",
        updatedAt: "2026-08-12T00:00:00Z",
      },
    ],
    page: { hasMore: false },
  });

  render(<CloudWorkspace />);
  await screen.findByText("Standalone Agents");
  fireEvent.click(screen.getByRole("button", { name: "Search" }));

  const dialog = screen.getByRole("dialog", { name: "Search workspace" });
  expect(within(dialog).getAllByText("Solo agent")).toHaveLength(1);
  expect(within(dialog).queryByText("Project")).not.toBeInTheDocument();
  expect(within(dialog).getByText("Session")).toBeVisible();
});

it("does not expose the obsolete per-project worker button", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  expect(
    screen.queryByRole("button", { name: "New worker" }),
  ).not.toBeInTheDocument();
});

it("does not issue failing GitHub requests before hosted authentication", async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json(
      { authenticated: false },
      { headers: { "Cache-Control": "no-store" } },
    ),
  );

  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/cloud/github-auth-status", {
      cache: "no-store",
    }),
  );

  expect(mocks.listGitHubInstallations).not.toHaveBeenCalled();
  expect(mocks.listGitHubRepositories).not.toHaveBeenCalled();
  expect(mocks.getGitHubUserConnection).not.toHaveBeenCalled();
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

it("uses an agent name instead of an orchestrator name for local scratch projects", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));
  fireEvent.click(screen.getByRole("button", { name: /Start from scratch/ }));
  fireEvent.change(screen.getByLabelText("Project name"), {
    target: { value: "Local scratch" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));

  await waitFor(() =>
    expect(mocks.createSession).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        kind: "orchestrator",
        harness: "claude-code",
        displayName: "Claude agent",
      }),
      { idempotencyKey: "test-key" },
    ),
  );
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

it("opens project actions and creates a real share link", async () => {
  mocks.createProjectShareLink.mockResolvedValue({
    link: {
      id: "link-1",
      orgId: "org-1",
      projectId: "project-1",
      role: "editor",
      status: "active",
      accessScope: "anyone",
      recipients: [],
      interaction: "interact",
      modeCap: "standard",
      deniedCommands: [],
      createdAt: "2026-08-13T00:00:00Z",
      updatedAt: "2026-08-13T00:00:00Z",
      url: "https://app.example.com/share/org-1/tok_abc123",
    },
  });
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Cloud platform" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Share project" }));

  const dialog = await screen.findByRole("dialog", {
    name: "Share Cloud platform",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));

  await waitFor(() =>
    expect(mocks.createProjectShareLink).toHaveBeenCalledWith(
      "org-1",
      "project-1",
      { role: "editor", interaction: "interact", accessScope: "anyone", recipients: [], modeCap: "standard" },
    ),
  );
  expect(
    await within(dialog).findByDisplayValue(
      "https://app.example.com/share/org-1/tok_abc123",
    ),
  ).toBeVisible();
});

it("updates project settings from the project action menu", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Cloud platform" }),
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Project settings" }),
  );

  const dialog = screen.getByRole("dialog", {
    name: "Project settings for Cloud platform",
  });
  fireEvent.change(within(dialog).getByLabelText("Project name"), {
    target: { value: "Cloud API" },
  });
  fireEvent.change(within(dialog).getByLabelText("Default branch"), {
    target: { value: "develop" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(mocks.updateProject).toHaveBeenCalledWith(
      "org-1",
      "project-1",
      {
        displayName: "Cloud API",
        defaultBranch: "develop",
      },
    ),
  );
  expect(
    await screen.findByRole("button", { name: "Actions for Cloud API" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("dialog", {
      name: "Project settings for Cloud platform",
    }),
  ).not.toBeInTheDocument();
});

it("deletes a project and removes all of its sessions from the workspace", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Cloud platform" }),
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Project settings" }),
  );
  fireEvent.click(
    within(
      screen.getByRole("dialog", {
        name: "Project settings for Cloud platform",
      }),
    ).getByRole("button", { name: "Delete project" }),
  );

  await waitFor(() =>
    expect(mocks.deleteProject).toHaveBeenCalledWith("org-1", "project-1"),
  );
  expect(
    screen.queryByRole("button", { name: "Actions for Cloud platform" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Build cloud authentication"),
  ).not.toBeInTheDocument();
});

it("deletes a session from its hover action menu", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<CloudWorkspace />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Actions for Build cloud authentication",
    }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete session" }));

  await waitFor(() =>
    expect(mocks.deleteSession).toHaveBeenCalledWith("org-1", "session-1"),
  );
  expect(screen.queryAllByText("Build cloud authentication")).toHaveLength(0);

  mocks.listSessions.mockClear();
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(mocks.listSessions).toHaveBeenCalled());
  expect(screen.queryAllByText("Build cloud authentication")).toHaveLength(0);
});
