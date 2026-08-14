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
  createProjectFromGitHub: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  createGitHubScratchProject: vi.fn(),
  startGitHubUserAuthorization: vi.fn(),
  startGitHubInstallation: vi.fn(),
  claimGitHubInstallation: vi.fn(),
  syncGitHubInstallation: vi.fn(),
  disconnectGitHubUser: vi.fn(),
  putAgentProviderConnection: vi.fn(),
  deleteAgentProviderConnection: vi.fn(),
  listUserProviderConnections: vi.fn(),
  putUserProviderConnection: vi.fn(),
  deleteUserProviderConnection: vi.fn(),
  promoteProviderConnection: vi.fn(),
  listOrgMembers: vi.fn(),
  listOrgInvitations: vi.fn(),
  listMyInvitations: vi.fn(),
  acceptOrgInvitation: vi.fn(),
  declineOrgInvitation: vi.fn(),
  createOrgInvitation: vi.fn(),
  revokeOrgInvitation: vi.fn(),
  listProjectShareLinks: vi.fn(),
  createProjectShareLink: vi.fn(),
  revokeProjectShareLink: vi.fn(),
  listProjectShareGrants: vi.fn(),
  revokeProjectShareGrant: vi.fn(),
  updateProjectShareGrant: vi.fn(),
  createOrganization: vi.fn(),
  updateOrgMemberRole: vi.fn(),
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
    createProjectFromGitHub: mocks.createProjectFromGitHub,
    updateProject: mocks.updateProject,
    deleteProject: mocks.deleteProject,
    createSession: mocks.createSession,
    deleteSession: mocks.deleteSession,
    createGitHubScratchProject: mocks.createGitHubScratchProject,
    startGitHubUserAuthorization: mocks.startGitHubUserAuthorization,
    startGitHubInstallation: mocks.startGitHubInstallation,
    claimGitHubInstallation: mocks.claimGitHubInstallation,
    syncGitHubInstallation: mocks.syncGitHubInstallation,
    disconnectGitHubUser: mocks.disconnectGitHubUser,
    putAgentProviderConnection: mocks.putAgentProviderConnection,
    deleteAgentProviderConnection: mocks.deleteAgentProviderConnection,
    listUserProviderConnections: mocks.listUserProviderConnections,
    putUserProviderConnection: mocks.putUserProviderConnection,
    deleteUserProviderConnection: mocks.deleteUserProviderConnection,
    promoteProviderConnection: mocks.promoteProviderConnection,
    listOrgMembers: mocks.listOrgMembers,
    listOrgInvitations: mocks.listOrgInvitations,
    listMyInvitations: mocks.listMyInvitations,
    acceptOrgInvitation: mocks.acceptOrgInvitation,
    declineOrgInvitation: mocks.declineOrgInvitation,
    createOrgInvitation: mocks.createOrgInvitation,
    revokeOrgInvitation: mocks.revokeOrgInvitation,
    listProjectShareLinks: mocks.listProjectShareLinks,
    createProjectShareLink: mocks.createProjectShareLink,
    revokeProjectShareLink: mocks.revokeProjectShareLink,
    listProjectShareGrants: mocks.listProjectShareGrants,
    revokeProjectShareGrant: mocks.revokeProjectShareGrant,
    updateProjectShareGrant: mocks.updateProjectShareGrant,
    createOrganization: mocks.createOrganization,
    updateOrgMemberRole: mocks.updateOrgMemberRole,
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
  mocks.startGitHubInstallation.mockResolvedValue({
    installationUrl: "https://github.com/apps/ao/installations/new",
  });
  mocks.syncGitHubInstallation.mockResolvedValue(undefined);
  mocks.getGitHubUserConnection.mockResolvedValue({
    connected: false,
    installations: [],
  });
  mocks.deleteSession.mockResolvedValue({
    session: { id: "session-1", desiredState: "deleted" },
  });
  mocks.listProviderConnections.mockResolvedValue([]);
  mocks.listUserProviderConnections.mockResolvedValue([]);
  mocks.promoteProviderConnection.mockResolvedValue({ providerConnection: null });
  mocks.listOrgMembers.mockResolvedValue([]);
  mocks.listOrgInvitations.mockResolvedValue([]);
  mocks.listMyInvitations.mockResolvedValue([]);
  mocks.createOrganization.mockResolvedValue({
    organization: {
      id: "org-2",
      slug: "workspace-org2",
      displayName: "Platform Team",
      role: "owner",
    },
  });
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
  mocks.createProjectFromGitHub.mockResolvedValue({
    project: {
      id: "project-imported",
      orgId: "org-1",
      displayName: "Imported repo",
      repositoryUrl: "https://github.com/acme/imported",
      defaultBranch: "main",
      config: {},
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
  mocks.putUserProviderConnection.mockResolvedValue({
    providerConnection: {
      id: "user-connection-1",
      provider: "claude-code",
      label: "default",
      config: { credentialType: "api_key" },
      validationState: "valid",
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:00Z",
    },
  });
  mocks.deleteAgentProviderConnection.mockResolvedValue(undefined);
  mocks.deleteUserProviderConnection.mockResolvedValue(undefined);
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
  await screen.findByText("Agents");
  fireEvent.click(screen.getByRole("button", { name: "Search" }));

  const dialog = screen.getByRole("dialog", { name: "Command palette" });
  expect(within(dialog).getAllByText("Solo agent")).toHaveLength(1);
  expect(within(dialog).getByRole("group", { name: "Sessions" })).toBeVisible();
});

it("shares a standalone agent", async () => {
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
  mocks.createProjectShareLink.mockResolvedValue({
    link: {
      id: "link-1",
      orgId: "org-1",
      projectId: "standalone-project",
      role: "editor",
      status: "active",
      accessScope: "anyone",
      recipients: [],
      interaction: "interact",
      modeCap: "standard",
      deniedCommands: [],
      createdAt: "2026-08-13T00:00:00Z",
      updatedAt: "2026-08-13T00:00:00Z",
      token: "tok_abc123",
    },
  });

  render(<CloudWorkspace />);
  await screen.findByText("Agents");
  fireEvent.click(screen.getByRole("button", { name: "Share" }));

  const dialog = await screen.findByRole("dialog", { name: "Share Solo agent" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));

  await waitFor(() =>
    expect(mocks.createProjectShareLink).toHaveBeenCalledWith(
      "org-1",
      "standalone-project",
      {
        role: "editor",
        interaction: "interact",
        accessScope: "anyone",
        recipients: [],
        modeCap: "standard",
      },
    ),
  );
});

it("does not expose the obsolete per-project worker button", async () => {
  render(<CloudWorkspace />);
  await screen.findByRole("button", { name: "Cloud platform" });

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
  await screen.findByRole("button", { name: "Cloud platform" });
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/cloud/github-auth-status", {
      cache: "no-store",
    }),
  );

  expect(mocks.listGitHubInstallations).not.toHaveBeenCalled();
  expect(mocks.listGitHubRepositories).not.toHaveBeenCalled();
  expect(mocks.getGitHubUserConnection).not.toHaveBeenCalled();
});

it("starts an orchestrator when importing a GitHub repository", async () => {
  mocks.listGitHubRepositories.mockResolvedValue({
    items: [{
      githubRepositoryId: "9",
      name: "imported",
      fullName: "acme/imported",
      htmlUrl: "https://github.com/acme/imported",
      defaultBranch: "main",
      visibility: "private",
      isPrivate: true,
      isArchived: false,
      access: "active",
      grantedAt: "2026-08-12T00:00:00Z",
    }],
    page: { hasMore: false },
  });

  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));
  fireEvent.click(await screen.findByRole("button", { name: /From GitHub/ }));
  fireEvent.click(screen.getByRole("button", { name: "Add project" }));

  await waitFor(() => expect(mocks.createSession).toHaveBeenCalledWith(
    "org-1",
    expect.objectContaining({
      projectId: "project-imported",
      kind: "orchestrator",
      harness: "claude-code",
      displayName: "Orchestrator",
      mode: "trusted",
    }),
    { idempotencyKey: "test-key" },
  ));
});

it("keeps the orchestrator first in its project and out of the task board", async () => {
  const worker = {
    id: "worker-session",
    orgId: "org-1",
    projectId: "project-1",
    kind: "worker" as const,
    harness: "claude-code",
    displayName: "Worker task",
    branch: "ao/worker",
    mode: "trusted" as const,
    deniedCommands: [],
    activityState: "idle" as const,
    status: "idle" as const,
    runtimeConnected: true,
    isTerminated: false,
    createdAt: "2026-08-12T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z",
  };
  const orchestrator = {
    ...worker,
    id: "orchestrator-session",
    kind: "orchestrator" as const,
    displayName: "Project orchestrator",
    branch: "ao/orchestrator",
  };
  mocks.listSessions.mockResolvedValue({
    items: [worker, orchestrator],
    page: { hasMore: false },
  });

  render(<CloudWorkspace />);

  const sidebar = await screen.findByRole("complementary");
  const orchestratorLabel = await within(sidebar).findByText(
    "Orchestrator",
  );
  const workerLabel = within(sidebar).getByText("Worker task");
  expect(
    orchestratorLabel.compareDocumentPosition(workerLabel) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const orchestratorRow = orchestratorLabel.closest("button")?.parentElement
    ?.parentElement;
  expect(orchestratorLabel.closest("button")?.querySelector("svg")).not.toBeNull();
  expect(
    within(sidebar).getByLabelText("Open orchestrator for Cloud platform"),
  ).toBeVisible();
  expect(
    orchestratorRow?.querySelector('[aria-label="Pin session"]'),
  ).toBeNull();
  expect(screen.getAllByText("Orchestrator")).toHaveLength(1);
});

it("creates and selects a workspace without reloading the page", async () => {
  mocks.listProjects.mockResolvedValueOnce({ items: [], page: { hasMore: false } });
  mocks.listProjects.mockResolvedValueOnce({ items: [], page: { hasMore: false } });
  mocks.listSessions.mockResolvedValueOnce({ items: [], page: { hasMore: false } });
  mocks.listSessions.mockResolvedValueOnce({ items: [], page: { hasMore: false } });
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");
  fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Create workspace/ }));
  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "Platform Team" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  await waitFor(() => expect(mocks.createOrganization).toHaveBeenCalledWith({
    displayName: "Platform Team",
  }));
  expect(await screen.findByText("Platform Team")).toBeVisible();
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
  expect(screen.getByText("Agents")).toBeVisible();
});

it("uses the canonical orchestrator name for local scratch projects", async () => {
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
        displayName: "Orchestrator",
      }),
      { idempotencyKey: "test-key" },
    ),
  );
});

it("creates a no-repository project with an independent worker", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.click(screen.getByRole("button", { name: /Create a Project/ }));
  fireEvent.click(screen.getByRole("button", { name: /Start from scratch/ }));
  fireEvent.change(screen.getByLabelText("Project name"), {
    target: { value: "Loose agents" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^No repository/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));

  await waitFor(() =>
    expect(mocks.createProject).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        displayName: "Loose agents",
        config: {
          source: "scratch-independent",
          scratch: true,
          standalone: false,
        },
      }),
      { idempotencyKey: "test-key" },
    ),
  );
  expect(mocks.createSession).toHaveBeenCalledWith(
    "org-1",
    expect.objectContaining({
      kind: "worker",
      displayName: "Loose agents",
    }),
    { idempotencyKey: "test-key" },
  );
});

it("searches the loaded workspace without demo commands", async () => {
  render(<CloudWorkspace />);
  await screen.findByRole("button", { name: "Cloud platform" });

  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const dialog = screen.getByRole("dialog", { name: "Command palette" });
  fireEvent.change(within(dialog).getByRole("combobox"), {
    target: { value: "authentication" },
  });

  expect(
    within(dialog).getByRole("option", {
      name: /Build cloud authentication/,
    }),
  ).toBeVisible();
  expect(within(dialog).queryByText("Open Settings")).not.toBeInTheDocument();
});

it("lets a connected GitHub user add another organization from settings", async () => {
  mocks.getGitHubUserConnection.mockResolvedValue({
    connected: true,
    login: "amoreX",
    installations: [],
  });
  mocks.listGitHubInstallations.mockResolvedValue([
    {
      id: "inst-1",
      githubInstallationId: "123",
      accountLogin: "amoreX",
      accountType: "User",
      status: "active",
      repositorySelection: "all",
      syncStatus: "ready",
      createdAt: "2026-08-12T00:00:00Z",
      updatedAt: "2026-08-12T00:00:00Z",
    },
  ]);
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Command palette" })).getByRole(
      "option",
      { name: "Settings" },
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  expect(screen.getAllByText("amoreX").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Connect organization" })).toBeVisible();
  expect(screen.queryByText("No GitHub installation")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sync" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();
});

it("recognizes a reconfigured GitHub installation and closes the popup", async () => {
  const oldInstallation = {
    id: "inst-1",
    githubInstallationId: "123",
    accountLogin: "acme",
    accountType: "Organization",
    status: "active",
    repositorySelection: "selected",
    syncStatus: "ready",
    createdAt: "2026-08-12T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z",
  };
  const updatedInstallation = {
    ...oldInstallation,
    repositorySelection: "all",
    updatedAt: "2026-08-12T00:01:00Z",
  };
  mocks.getGitHubUserConnection.mockResolvedValue({
    connected: true,
    login: "amoreX",
    installations: [],
  });
  mocks.listGitHubInstallations
    .mockResolvedValueOnce([oldInstallation])
    .mockResolvedValue([updatedInstallation]);
  const popup = {
    closed: false,
    close: vi.fn(),
    location: { assign: vi.fn() },
  };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Command palette" })).getByRole(
      "option",
      { name: "Settings" },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  fireEvent.click(screen.getByRole("button", { name: "Manage organization repository access" }));

  await waitFor(() => expect(mocks.syncGitHubInstallation).toHaveBeenCalledWith("org-1", "inst-1"));
  expect(popup.close).toHaveBeenCalled();
});

it("continues from account authorization to organization installation when only a personal installation exists", async () => {
  const personalInstallation = {
    id: "inst-personal",
    githubInstallationId: "101",
    accountLogin: "amoreX",
    accountType: "User",
    status: "active",
    repositorySelection: "all",
    syncStatus: "ready",
    createdAt: "2026-08-12T00:00:00Z",
    updatedAt: "2026-08-12T00:00:00Z",
  };
  const organizationInstallation = {
    ...personalInstallation,
    id: "inst-org",
    githubInstallationId: "202",
    accountLogin: "rae-app",
    accountType: "Organization",
    updatedAt: "2026-08-12T00:01:00Z",
  };
  const connectedUser = {
    connected: true,
    login: "amoreX",
    installations: [
      {
        githubInstallationId: "101",
        accountLogin: "amoreX",
        accountType: "User",
        repositorySelection: "all",
        canCreateRepository: true,
      },
    ],
  };
  mocks.startGitHubUserAuthorization.mockResolvedValue({
    authorizeUrl: "https://github.com/login/oauth/authorize",
  });
  mocks.getGitHubUserConnection
    .mockResolvedValueOnce({ connected: false, installations: [] })
    .mockResolvedValue(connectedUser);
  mocks.listGitHubInstallations
    .mockResolvedValueOnce([personalInstallation])
    .mockResolvedValue([organizationInstallation]);
  const popup = {
    closed: false,
    close: vi.fn(),
    location: { assign: vi.fn() },
  };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Command palette" })).getByRole(
      "option",
      { name: "Settings" },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));

  await waitFor(() => expect(mocks.startGitHubInstallation).toHaveBeenCalledWith("org-1"));
  expect(popup.location.assign).toHaveBeenCalledWith(
    "https://github.com/apps/ao/installations/new",
  );
  await waitFor(() =>
    expect(mocks.syncGitHubInstallation).toHaveBeenCalledWith("org-1", "inst-org"),
  );
  expect(popup.close).toHaveBeenCalled();
});

it("claims an existing GitHub organization installation after it is configured", async () => {
  const beforeConnection = {
    connected: true,
    login: "amoreX",
    installations: [
      {
        githubInstallationId: "153693921",
        accountLogin: "unordinarytech",
        accountType: "Organization",
        repositorySelection: "selected",
        canCreateRepository: false,
        unavailableReason: "Configure the GitHub App for all repositories first.",
      },
    ],
  };
  const afterConnection = {
    ...beforeConnection,
    installations: [
      {
        ...beforeConnection.installations[0],
        repositorySelection: "all",
        canCreateRepository: true,
        unavailableReason: "",
      },
    ],
  };
  mocks.getGitHubUserConnection.mockResolvedValue(beforeConnection);
  mocks.listGitHubInstallations.mockResolvedValue([]);
  mocks.claimGitHubInstallation.mockResolvedValue({
    installation: {
      id: "inst-unordinarytech",
      githubInstallationId: "153693921",
      accountLogin: "unordinarytech",
      accountType: "Organization",
      status: "active",
      repositorySelection: "all",
      syncStatus: "ready",
      createdAt: "2026-08-14T00:00:00Z",
      updatedAt: "2026-08-14T00:00:00Z",
    },
  });
  const popup = {
    closed: false,
    close: vi.fn(),
    location: { assign: vi.fn() },
  };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Command palette" })).getByRole(
      "option",
      { name: "Settings" },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  mocks.getGitHubUserConnection.mockResolvedValue(afterConnection);
  fireEvent.click(screen.getByRole("button", { name: "Connect organization" }));

  expect(await screen.findByText("Waiting for GitHub…")).toBeVisible();
  await waitFor(() =>
    expect(mocks.claimGitHubInstallation).toHaveBeenCalledWith(
      "org-1",
      "153693921",
    ),
  );
  expect(mocks.syncGitHubInstallation).not.toHaveBeenCalled();
  expect(popup.close).toHaveBeenCalled();
});

it("refreshes a configured personal GitHub installation without trying to claim it", async () => {
  const beforeConnection = {
    connected: true,
    login: "amoreX",
    installations: [
      {
        githubInstallationId: "153691581",
        accountLogin: "amoreX",
        accountType: "User",
        repositorySelection: "selected",
        canCreateRepository: false,
        unavailableReason: "Configure the GitHub App for all repositories first.",
      },
    ],
  };
  const afterConnection = {
    ...beforeConnection,
    installations: [
      {
        ...beforeConnection.installations[0],
        repositorySelection: "all",
        canCreateRepository: true,
        unavailableReason: "",
      },
    ],
  };
  mocks.getGitHubUserConnection.mockResolvedValue(beforeConnection);
  mocks.listGitHubInstallations.mockResolvedValue([]);
  const popup = {
    closed: false,
    close: vi.fn(),
    location: { assign: vi.fn() },
  };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);

  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Command palette" })).getByRole(
      "option",
      { name: "Settings" },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  mocks.getGitHubUserConnection.mockResolvedValue(afterConnection);
  fireEvent.click(screen.getByRole("button", { name: "Connect organization" }));

  await waitFor(() => expect(popup.close).toHaveBeenCalled());
  expect(mocks.claimGitHubInstallation).not.toHaveBeenCalled();
  expect(mocks.getGitHubUserConnection).toHaveBeenCalled();
});

it("connects coding-agent credentials from provider settings", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Command palette" })).getByRole(
      "option",
      { name: "Settings" },
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  expect(screen.getByText("GitHub account not connected")).toBeVisible();
  expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
  fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]);
  fireEvent.change(screen.getByLabelText("Secret"), {
    target: { value: "sk-ant-test" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(mocks.putUserProviderConnection).toHaveBeenCalledWith(
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
      token: "tok_abc123",
      url: "https://wrong-internal-host.example/share/org-1/tok_abc123",
    },
  });
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.pointerDown(await screen.findByRole("button", { name: "Actions for Cloud platform" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Share project" }));

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
      `${window.location.origin}/share/org-1/tok_abc123`,
    ),
  ).toBeVisible();
});

it("updates project settings from the project action menu", async () => {
  render(<CloudWorkspace />);
  await screen.findByText("Dev Team");

  fireEvent.contextMenu(await screen.findByRole("button", { name: "Cloud platform" }));
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

  fireEvent.contextMenu(await screen.findByRole("button", { name: "Cloud platform" }));
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

it("deletes a session and its now-empty project", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<CloudWorkspace />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete session" }));

  await waitFor(() =>
    expect(mocks.deleteSession).toHaveBeenCalledWith("org-1", "session-1"),
  );
  await waitFor(() =>
    expect(mocks.deleteProject).toHaveBeenCalledWith("org-1", "project-1"),
  );
  expect(screen.queryAllByText("Build cloud authentication")).toHaveLength(0);
  expect(screen.queryAllByText("Cloud platform")).toHaveLength(0);

  mocks.listSessions.mockClear();
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(mocks.listSessions).toHaveBeenCalled());
  expect(screen.queryAllByText("Build cloud authentication")).toHaveLength(0);
});
