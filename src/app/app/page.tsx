"use client";

import {
  CloudApiError,
  type CurrentAccount,
  type GitHubInstallation,
  type GitHubRepository,
  type Project,
  type PutAgentProviderConnectionInput,
  type RedactedProviderConnection,
  type Session,
  type UpdateProjectInput,
} from "@aoagents/cloud-client";
import { Folder, Menu, Plus, Search, Settings, X } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { browserCloudClient, newIdempotencyKey } from "@/lib/cloud-client";
import { CloudBoard } from "./CloudBoard";
import {
  NewProjectDialog,
  type LocalAgentInput,
  type ScratchProjectInput,
} from "./CloudDialogs";
import { CloudCreateWorkspaceDialog } from "./CloudCreateWorkspaceDialog";
import { CloudNewSessionDialog } from "./CloudNewSessionDialog";
import { CloudSettings } from "./CloudSettings";
import { CloudProjectSettingsDialog } from "./CloudProjectSettingsDialog";
import { CloudShareDialog } from "./CloudShareDialog";
import { CloudMainShell, CloudTopbar } from "./CloudShell";
import { CloudSessionWorkspace } from "./CloudSessionWorkspace";
import { CloudSidebar, isStandaloneProject } from "./CloudSidebar";
import {
  initialGitHubCapability,
  initialGitHubUserCapability,
  type GitHubCapability,
  type GitHubUserCapability,
  initialProviderCapability,
  type ProviderCapability,
} from "./cloud-ui-types";

export function CloudWorkspace() {
  const client = useMemo(browserCloudClient, []);
  const [account, setAccount] = useState<CurrentAccount | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<
    "general" | "workspaces" | "providers"
  >("general");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(null);
  const [projectSettings, setProjectSettings] = useState<Project | null>(null);
  const [projectSettingsBusy, setProjectSettingsBusy] = useState(false);
  const [shareProject, setShareProject] = useState<Project | null>(null);
  const [github, setGitHub] = useState<GitHubCapability>(
    initialGitHubCapability,
  );
  const [githubUser, setGitHubUser] = useState<GitHubUserCapability>(
    initialGitHubUserCapability,
  );
  const [githubBusy, setGitHubBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderCapability>(
    initialProviderCapability,
  );
  const [providerBusy, setProviderBusy] = useState(false);
  const organizationRequest = useRef(0);
  const githubRequest = useRef(0);
  const providerRequest = useRef(0);
  const deletingSessionIds = useRef(new Set<string>());
  const [previewUi, setPreviewUi] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    setPreviewUi(new URLSearchParams(window.location.search).get("ui") === "next");
  }, []);

  const loadGitHubUser = useCallback(async () => {
    setGitHubUser(initialGitHubUserCapability);
    try {
      const connection = await client.getGitHubUserConnection();
      setGitHubUser({ status: "available", connection });
    } catch (cause) {
      if (
        cause instanceof CloudApiError &&
        cause.status === 401 &&
        cause.code === "GITHUB_AUTH_REQUIRED"
      ) {
        setGitHubUser({
          status: "auth-required",
          connection: { connected: false, installations: [] },
          message: cause.message,
        });
        return;
      }
      setGitHubUser({
        status: "error",
        connection: { connected: false, installations: [] },
        message:
          cause instanceof Error
            ? cause.message
            : "Could not load GitHub authorization.",
      });
    }
  }, [client]);

  const loadGitHub = useCallback(
    async (orgId: string) => {
      const request = githubRequest.current + 1;
      githubRequest.current = request;
      setGitHub(initialGitHubCapability);
      try {
        const [installations, repositories] = await Promise.all([
          client.listGitHubInstallations(orgId),
          client.listGitHubRepositories(orgId, { limit: 100 }),
        ]);
        if (githubRequest.current !== request) return;
        setGitHub({
          status: "available",
          installations,
          repositories: repositories.items,
        });
      } catch (cause) {
        if (githubRequest.current !== request) return;
        if (
          cause instanceof CloudApiError &&
          cause.status === 401 &&
          cause.code === "GITHUB_AUTH_REQUIRED"
        ) {
          setGitHub({
            status: "auth-required",
            installations: [],
            repositories: [],
            message: cause.message,
          });
          return;
        }
        if (cause instanceof CloudApiError && cause.status === 404) {
          setGitHub({
            status: "unavailable",
            installations: [],
            repositories: [],
            message:
              "GitHub is intentionally disabled for local and staging environments.",
          });
          return;
        }
        setGitHub({
          status: "error",
          installations: [],
          repositories: [],
          message:
            cause instanceof Error
              ? cause.message
              : "Could not load GitHub connection.",
        });
      }
    },
    [client],
  );

  const loadGitHubCapabilities = useCallback(
    async (orgId: string) => {
      setGitHub(initialGitHubCapability);
      setGitHubUser(initialGitHubUserCapability);
      try {
        const response = await fetch("/api/cloud/github-auth-status", {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error("Could not check hosted GitHub authentication.");
        }
        const status = (await response.json()) as { authenticated?: boolean };
        if (!status.authenticated) {
          const message =
            "Connect your hosted AO account to manage GitHub access.";
          setGitHub({
            status: "auth-required",
            installations: [],
            repositories: [],
            message,
          });
          setGitHubUser({
            status: "auth-required",
            connection: { connected: false, installations: [] },
            message,
          });
          return;
        }
        await Promise.all([loadGitHub(orgId), loadGitHubUser()]);
      } catch (cause) {
        const message =
          cause instanceof Error
            ? cause.message
            : "Could not check GitHub authentication.";
        setGitHub({
          status: "error",
          installations: [],
          repositories: [],
          message,
        });
        setGitHubUser({
          status: "error",
          connection: { connected: false, installations: [] },
          message,
        });
      }
    },
    [loadGitHub, loadGitHubUser],
  );

  const loadOrganization = useCallback(
    async (orgId: string) => {
      const request = organizationRequest.current + 1;
      organizationRequest.current = request;
      setLoading(true);
      setError("");
      try {
        const [projectPage, sessionPage] = await Promise.all([
          client.listProjects(orgId, { limit: 100 }),
          client.listSessions(orgId, { limit: 100 }),
        ]);
        if (organizationRequest.current !== request) return;
        setProjects(projectPage.items);
        setSessions(
          sessionPage.items.filter(
            (session) =>
              !session.isTerminated &&
              !deletingSessionIds.current.has(session.id),
          ),
        );
        setSelectedProjectId((current) =>
          current && projectPage.items.some(({ id }) => id === current)
            ? current
            : (projectPage.items[0]?.id ?? null),
        );
        void loadGitHubCapabilities(orgId);
        const providerLoad = providerRequest.current + 1;
        providerRequest.current = providerLoad;
        setProviders(initialProviderCapability);
        void client
          .listProviderConnections(orgId)
          .then((connections) => {
            if (providerRequest.current !== providerLoad) return;
            setProviders({ status: "available", connections });
          })
          .catch((cause) => {
            if (providerRequest.current !== providerLoad) return;
            setProviders({
              status: "error",
              connections: [],
              message:
                cause instanceof Error
                  ? cause.message
                  : "Could not load provider connections.",
            });
          });
      } catch (cause) {
        if (organizationRequest.current === request) {
          handleLoadError(cause, setError);
        }
      } finally {
        if (organizationRequest.current === request) setLoading(false);
      }
    },
    [client, loadGitHubCapabilities],
  );

  useEffect(() => {
    let active = true;
    void client
      .getCurrentAccount()
      .then((value) => {
        if (!active) return;
        setAccount(value);
        const firstOrganization = value.organizations[0]?.id;
        if (!firstOrganization) {
          setError("Your account has no active workspace memberships.");
          setLoading(false);
          return;
        }
        setOrganizationId(firstOrganization);
        void loadOrganization(firstOrganization);
      })
      .catch((cause) => {
        if (active) {
          handleLoadError(cause, setError);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, loadOrganization]);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    let refreshing = false;
    const refreshSessions = async () => {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      try {
        const page = await client.listSessions(organizationId, { limit: 100 });
        if (active) {
          setSessions(
            page.items.filter(
              (session) =>
                !session.isTerminated &&
                !deletingSessionIds.current.has(session.id),
            ),
          );
        }
      } catch (cause) {
        if (
          active &&
          cause instanceof CloudApiError &&
          cause.status === 401
        ) {
          window.location.assign("/");
        }
      } finally {
        refreshing = false;
      }
    };
    const interval = window.setInterval(() => void refreshSessions(), 1_500);
    const onVisibility = () => void refreshSessions();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, organizationId]);

  useEffect(() => {
    const settings = new URLSearchParams(window.location.search).get("settings");
    if (settings === "providers") {
      setSettingsTarget("general");
      setSettingsOpen(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setNewProjectOpen(false);
        setProjectSettings(null);
        setShareProject(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const createProjectFromGitHub = async (repository: GitHubRepository) => {
    const response = await client.createProjectFromGitHub(
      organizationId,
      { githubRepositoryId: repository.githubRepositoryId },
      { idempotencyKey: newIdempotencyKey("github-project") },
    );
    setProjects((current) => [...current, response.project]);
    setSelectedProjectId(response.project.id);
  };

  const createScratchWork = async (
    input: LocalAgentInput,
    kind: "worker" | "orchestrator",
  ) => {
    const suffix = crypto.randomUUID();
    const projectResponse = await client.createProject(
      organizationId,
      {
        displayName: input.displayName,
        repositoryUrl: `https://scratch.ao.local/${suffix}`,
        defaultBranch: "main",
        config: {
          source: kind === "worker" ? "standalone-agent" : "scratch",
          scratch: true,
          standalone: kind === "worker",
        },
      },
      { idempotencyKey: newIdempotencyKey("scratch-project") },
    );
    const sessionResponse = await client.createSession(
      organizationId,
      {
        projectId: projectResponse.project.id,
        kind,
        harness: input.harness,
        displayName:
          kind === "orchestrator"
            ? localAgentName(input.harness)
            : input.displayName,
        prompt: input.prompt,
        mode: "trusted",
        deniedCommands: [],
      },
      { idempotencyKey: newIdempotencyKey("scratch-session") },
    );
    setProjects((current) => [...current, projectResponse.project]);
    setSessions((current) => [...current, sessionResponse.session]);
    setSelectedProjectId(projectResponse.project.id);
    setSelectedSessionId(sessionResponse.session.id);
  };

  const createSessionInProject = async (
    projectId: string,
    input: { displayName: string; harness: string; prompt: string },
  ) => {
    const sessionResponse = await client.createSession(
      organizationId,
      {
        projectId,
        kind: "worker",
        harness: input.harness,
        displayName: input.displayName,
        prompt: input.prompt,
        mode: "trusted",
        deniedCommands: [],
      },
      { idempotencyKey: newIdempotencyKey("project-session") },
    );
    setSessions((current) => [...current, sessionResponse.session]);
    setSelectedProjectId(projectId);
    setSelectedSessionId(sessionResponse.session.id);
  };

  const createScratchProject = async (input: ScratchProjectInput) => {
    if (!input.githubInstallationId) {
      await createScratchWork(input, "orchestrator");
      return;
    }
    const response = await client.createGitHubScratchProject(
      organizationId,
      {
        displayName: input.displayName,
        githubInstallationId: input.githubInstallationId,
        private: input.private ?? true,
        orchestrator: {
          harness: input.harness,
          prompt: input.prompt,
        },
      },
      { idempotencyKey: newIdempotencyKey("github-scratch-project") },
    );
    setProjects((current) => [...current, response.project]);
    setSessions((current) => [...current, response.session]);
    setSelectedProjectId(response.project.id);
    setSelectedSessionId(response.session.id);
    void loadGitHub(organizationId);
  };

  const updateProject = async (
    project: Project,
    input: UpdateProjectInput,
  ) => {
    setProjectSettingsBusy(true);
    try {
      const response = await client.updateProject(
        organizationId,
        project.id,
        input,
      );
      setProjects((current) =>
        current.map((item) =>
          item.id === response.project.id ? response.project : item,
        ),
      );
      setProjectSettings(null);
    } finally {
      setProjectSettingsBusy(false);
    }
  };

  const deleteProject = async (project: Project) => {
    setProjectSettingsBusy(true);
    try {
      await client.deleteProject(organizationId, project.id);
      setProjects((current) =>
        current.filter(({ id }) => id !== project.id),
      );
      setSessions((current) =>
        current.filter(({ projectId }) => projectId !== project.id),
      );
      if (selectedProjectId === project.id) setSelectedProjectId(null);
      if (
        selectedSessionId &&
        sessions.some(
          ({ id, projectId }) =>
            id === selectedSessionId && projectId === project.id,
        )
      ) {
        setSelectedSessionId(null);
      }
      setProjectSettings(null);
    } finally {
      setProjectSettingsBusy(false);
    }
  };

  const connectGitHub = async () => {
    if (
      github.status === "auth-required" ||
      githubUser.status === "auth-required"
    ) {
      window.location.assign("/github-sign-in");
      return;
    }
    setGitHubBusy(true);
    setError("");
    let popup: Window | null = null;
    try {
      if (!githubUser.connection.connected) {
        const attempt = await client.startGitHubUserAuthorization();
        popup = window.open(
          attempt.authorizeUrl,
          "ao-github-connect",
          "popup,width=900,height=760",
        );
        if (!popup) {
          throw new Error(
            "Allow popups for this site to connect GitHub in one flow.",
          );
        }
        const deadline = Date.now() + 2 * 60 * 1000;
        let authorized = false;
        while (Date.now() < deadline) {
          const connection = await client.getGitHubUserConnection();
          if (connection.connected) {
            authorized = true;
            setGitHubUser({ status: "available", connection });
            break;
          }
          await delay(300);
        }
        if (!authorized) {
          throw new Error("GitHub account authorization did not complete.");
        }
      }

      const before = new Set(
        github.status === "available"
          ? github.installations.map(({ githubInstallationId }) => githubInstallationId)
          : [],
      );
      const attempt = await client.startGitHubInstallation(organizationId);
      if (popup && !popup.closed) {
        popup.location.assign(attempt.installationUrl);
      } else {
        popup = window.open(
          attempt.installationUrl,
          "ao-github-connect",
          "popup,width=900,height=760",
        );
      }
      if (!popup) {
        throw new Error(
          "Allow popups for this site to finish connecting the GitHub App.",
        );
      }

      const deadline = Date.now() + 2 * 60 * 1000;
      let installationConnected = false;
      while (Date.now() < deadline) {
        const installations = await client.listGitHubInstallations(organizationId);
        if (
          installations.some(
            ({ githubInstallationId }) => !before.has(githubInstallationId),
          )
        ) {
          installationConnected = true;
          break;
        }
        await delay(500);
      }
      if (!installationConnected) {
        throw new Error("The AO GitHub App installation did not complete.");
      }
      popup.close();
      await Promise.all([loadGitHubUser(), loadGitHub(organizationId)]);
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setGitHubBusy(false);
    }
  };

  const disconnectGitHubUser = async () => {
    setGitHubBusy(true);
    setError("");
    try {
      await client.disconnectGitHubUser();
      await loadGitHubUser();
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setGitHubBusy(false);
    }
  };

  const syncGitHubInstallation = async (
    installation: GitHubInstallation,
  ) => {
    setGitHubBusy(true);
    setError("");
    try {
      await client.syncGitHubInstallation(organizationId, installation.id);
      await loadGitHub(organizationId);
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setGitHubBusy(false);
    }
  };

  const disconnectGitHubInstallation = async (
    installation: GitHubInstallation,
  ) => {
    setGitHubBusy(true);
    setError("");
    try {
      await client.disconnectGitHubInstallation(
        organizationId,
        installation.id,
      );
      await loadGitHub(organizationId);
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setGitHubBusy(false);
    }
  };

  const connectAgentProvider = async (
    provider: "claude-code" | "codex" | "cursor",
    input: PutAgentProviderConnectionInput,
  ) => {
    setProviderBusy(true);
    setError("");
    try {
      const response = await client.putAgentProviderConnection(
        organizationId,
        provider,
        input,
      );
      setProviders((current) => ({
        status: "available",
        connections: [
          ...current.connections.filter(
            (connection) => connection.provider !== provider,
          ),
          response.providerConnection,
        ],
      }));
    } catch (cause) {
      handleLoadError(cause, setError);
      throw cause;
    } finally {
      setProviderBusy(false);
    }
  };

  const disconnectAgentProvider = async (
    connection: RedactedProviderConnection,
  ) => {
    const provider = connection.provider;
    if (
      provider !== "claude-code" &&
      provider !== "codex" &&
      provider !== "cursor"
    ) {
      return;
    }
    setProviderBusy(true);
    setError("");
    try {
      await client.deleteAgentProviderConnection(organizationId, provider);
      setProviders((current) => ({
        ...current,
        connections: current.connections.filter(
          (item) => item.id !== connection.id,
        ),
      }));
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setProviderBusy(false);
    }
  };

  const deleteSession = async (session: Session) => {
    setError("");
    try {
      await client.deleteSession(organizationId, session.id);
      deletingSessionIds.current.add(session.id);
      setSessions((current) => current.filter(({ id }) => id !== session.id));
      if (selectedSessionId === session.id) setSelectedSessionId(null);
    } catch (cause) {
      handleLoadError(cause, setError);
    }
  };

  if (!account) {
    return <LoadingState error={error} loading={loading} />;
  }

  const selectedProject =
    projects.find(({ id }) => id === selectedProjectId) ?? null;
  const visibleSessions = selectedProjectId
    ? sessions.filter(({ projectId }) => projectId === selectedProjectId)
    : sessions;
  const selectedSession =
    sessions.find(({ id }) => id === selectedSessionId) ?? null;

  return (
    <main
      data-testid="cloud-workspace"
      className="fixed inset-0 h-dvh overflow-hidden bg-[var(--color-bg-primary)] font-sans tracking-normal text-[var(--color-text-primary)] [color-scheme:dark] [&_*]:[scrollbar-color:rgb(255_255_255_/_12%)_transparent] [&_*]:[scrollbar-width:thin]"
    >
      <div className={`grid h-full grid-cols-1 ${sidebarCollapsed ? "lg:grid-cols-[0px_minmax(0,1fr)]" : "lg:grid-cols-[240px_minmax(0,1fr)]"} transition-[grid-template-columns] duration-200 ease-out`}>
        {previewUi && mobileNavOpen ? <button type="button" aria-label="Close navigation overlay" className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setMobileNavOpen(false)} /> : null}
        <CloudSidebar
          account={account}
          onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
          onDeleteProject={(project) => void deleteProject(project)}
          onDeleteSession={(session) => void deleteSession(session)}
          onNewProject={() => setNewProjectOpen(true)}
          onNewSession={(projectId) => {
            setNewSessionProjectId(projectId);
          }}
          onOpenCommand={() => setCommandOpen(true)}
          onOpenSettings={() => {
            setSettingsTarget("general");
            setSettingsOpen(true);
            setSelectedSessionId(null);
          }}
          onSelectOrganization={(id) => {
            setOrganizationId(id);
            setSelectedProjectId(null);
            setSelectedSessionId(null);
            void loadOrganization(id);
          }}
          onSelectProject={(id) => {
            setSelectedProjectId(id);
            setSelectedSessionId(null);
          }}
          onSelectSession={(id) => {
            const session = sessions.find((item) => item.id === id);
            if (session) setSelectedProjectId(session.projectId);
            setSelectedSessionId(id);
          }}
          onProjectSettings={setProjectSettings}
          onShareProject={setShareProject}
          projects={projects}
          selectedOrganizationId={organizationId}
          selectedProjectId={selectedProjectId}
          selectedSessionId={selectedSessionId}
          sessions={sessions}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          parity={previewUi}
        />
        <CloudMainShell parity={previewUi}>
          {selectedSession ? (
            <CloudSessionWorkspace
              onClose={() => setSelectedSessionId(null)}
              onDelete={() => { void deleteSession(selectedSession); setSelectedSessionId(null); }}
              onNewTask={() => setNewSessionProjectId(selectedSession.projectId)}
              onShare={() => {
                const project = projects.find((p) => p.id === selectedSession.projectId);
                if (project) setShareProject(project);
              }}
              onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
              sidebarOpen={!sidebarCollapsed}
              organizationId={organizationId}
              session={selectedSession}
            />
          ) : (
            <>
              <CloudTopbar
                title={selectedProject?.displayName ?? "All projects"}
                onOpenSidebar={previewUi ? () => setMobileNavOpen(true) : undefined}
                onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
                sidebarOpen={!sidebarCollapsed}
                showBoardActions={!!selectedProjectId}
                onNewTask={selectedProjectId ? () => setNewSessionProjectId(selectedProjectId) : undefined}
                onOrchestrator={selectedProjectId ? () => setNewSessionProjectId(selectedProjectId) : undefined}
                onShare={selectedProject ? () => setShareProject(selectedProject) : undefined}
              />
              <div className="relative min-h-0 flex-1">
                {error ? (
                  <div
                    className="absolute inset-x-4 top-4 z-20 rounded-md border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-xs text-[var(--color-error)]"
                    role="alert"
                  >
                    {error}
                  </div>
                ) : null}
                {loading ? (
                  <div className="grid h-full place-items-center text-xs text-[var(--color-text-passive)]">
                    Loading workspace…
                  </div>
                ) : (
                  <CloudBoard
                    onDeleteSession={(session) => void deleteSession(session)}
                    onPinSession={() => {}}
                    onSelectSession={setSelectedSessionId}
                    sessions={visibleSessions}
                  />
                )}
              </div>
            </>
          )}
        </CloudMainShell>
      </div>
      <CloudSettings
          account={account}
          busy={githubBusy}
          github={github}
          githubUser={githubUser}
          initialPanel={settingsTarget}
          open={settingsOpen}
          onConnectGitHub={connectGitHub}
          onConnectAgent={connectAgentProvider}
          onDisconnectAgent={disconnectAgentProvider}
          onBack={() => setSettingsOpen(false)}
          onDisconnectGitHub={disconnectGitHubInstallation}
          onDisconnectGitHubUser={disconnectGitHubUser}
          onSelectOrganization={(id) => {
            setOrganizationId(id);
            setSelectedProjectId(null);
            setSelectedSessionId(null);
            void loadOrganization(id);
          }}
          onSyncGitHub={syncGitHubInstallation}
          providerBusy={providerBusy}
          providers={providers}
          selectedOrganizationId={organizationId}
      />
      <CloudSearch
        open={commandOpen}
        onOpenChange={setCommandOpen}
        onSelectProject={(id) => {
          setSelectedProjectId(id);
          setSelectedSessionId(null);
          setCommandOpen(false);
        }}
        onSelectSession={(id) => {
          const session = sessions.find((item) => item.id === id);
          if (session) setSelectedProjectId(session.projectId);
          setSelectedSessionId(id);
          setCommandOpen(false);
        }}
        onNewProject={() => {
          setCommandOpen(false);
          setNewProjectOpen(true);
        }}
        onOpenSettings={() => {
          setCommandOpen(false);
          setSettingsTarget("general");
          setSettingsOpen(true);
        }}
        projects={projects}
        sessions={sessions}
      />
      <NewProjectDialog
        connectedProviders={providers.status === "available" ? providers.connections.map((c) => c.provider) : []}
        github={github}
        githubUser={githubUser}
        onClose={() => setNewProjectOpen(false)}
        onCreateFromGitHub={createProjectFromGitHub}
        onCreateScratchProject={createScratchProject}
        onCreateStandalone={(input) => createScratchWork(input, "worker")}
        onOpenProviderSettings={() => {
          setNewProjectOpen(false);
          setSettingsTarget("general");
          setSettingsOpen(true);
        }}
        open={newProjectOpen}
      />
      <CloudCreateWorkspaceDialog
        open={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        onCreated={() => { setCreateWorkspaceOpen(false); window.location.reload(); }}
      />
      <CloudNewSessionDialog
        open={newSessionProjectId !== null}
        projectName={projects.find((p) => p.id === newSessionProjectId)?.displayName ?? ""}
        connectedProviders={providers.status === "available" ? providers.connections.map((c) => c.provider) : []}
        onClose={() => setNewSessionProjectId(null)}
        onCreate={(input) => createSessionInProject(newSessionProjectId!, input)}
      />
      <CloudShareDialog
        onClose={() => setShareProject(null)}
        open={shareProject !== null}
        project={shareProject}
      />
      {projectSettings ? (
        <CloudProjectSettingsDialog
          busy={projectSettingsBusy}
          onClose={() => setProjectSettings(null)}
          onDelete={() => deleteProject(projectSettings)}
          onSave={(input) => updateProject(projectSettings, input)}
          project={projectSettings}
        />
      ) : null}
    </main>
  );
}

export default CloudWorkspace;

function LoadingState({
  error,
  loading,
}: {
  error: string;
  loading: boolean;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--color-bg-primary)] p-6 text-[var(--foreground)]">
      <div className="max-w-sm text-center">
        <p className="text-sm">
          {loading ? "Loading your Cloud workspace…" : error}
        </p>
        {!loading && error ? (
          <a
            className="mt-4 inline-block text-xs text-[#8bb5ff] hover:underline"
            href="/"
          >
            Return to sign in
          </a>
        ) : null}
      </div>
    </main>
  );
}

function CloudSearch({
  open,
  onOpenChange,
  onSelectProject,
  onSelectSession,
  onNewProject,
  onOpenSettings,
  projects,
  sessions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectProject: (id: string) => void;
  onSelectSession: (id: string) => void;
  onNewProject: () => void;
  onOpenSettings: () => void;
  projects: Project[];
  sessions: Session[];
}) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search projects, sessions, and commands…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Projects">
          {projects.filter((p) => !isStandaloneProject(p)).map((project) => (
            <CommandItem
              key={project.id}
              value={`project ${project.displayName} ${project.repositoryUrl}`}
              onSelect={() => onSelectProject(project.id)}
            >
              <Folder className="size-3.5" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
              <span className="max-w-[45%] truncate text-xs text-[var(--color-text-passive)]">
                {project.repositoryUrl}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
        {sessions.length > 0 ? (
          <CommandGroup heading="Sessions">
            {sessions.map((session) => (
              <CommandItem
                key={session.id}
                value={`session ${session.displayName} ${session.branch}`}
                onSelect={() => onSelectSession(session.id)}
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${activityDot(session.activityState)}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{session.displayName}</span>
                <span className="max-w-[45%] truncate text-xs text-[var(--color-text-passive)]">
                  {session.branch}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Actions">
          <CommandItem value="new project create" onSelect={onNewProject}>
            <Plus className="size-3.5" aria-hidden="true" />
            New project
          </CommandItem>
          <CommandItem value="settings preferences" onSelect={onOpenSettings}>
            <Settings className="size-3.5" aria-hidden="true" />
            Settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function activityDot(activity: Session["activityState"]): string {
  if (activity === "active") return "bg-status-working";
  if (activity === "waiting_input" || activity === "blocked") return "bg-status-needs-you";
  if (activity === "exited") return "bg-status-exited";
  return "bg-status-idle";
}

function handleLoadError(
  cause: unknown,
  setError: (message: string) => void,
) {
  if (cause instanceof CloudApiError && cause.status === 401) {
    window.location.assign("/");
    return;
  }
  setError(cause instanceof Error ? cause.message : "Could not load workspace.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function localAgentName(harness: string): string {
  switch (harness) {
    case "claude-code":
      return "Claude agent";
    case "codex":
      return "Codex agent";
    case "cursor":
      return "Cursor agent";
    default:
      return "Agent";
  }
}
