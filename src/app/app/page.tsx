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
} from "@aoagents/cloud-client";
import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { browserCloudClient, newIdempotencyKey } from "@/lib/cloud-client";
import { CloudBoard } from "./CloudBoard";
import { NewProjectDialog } from "./CloudDialogs";
import { CloudSettings } from "./CloudSettings";
import { CloudShareDialog } from "./CloudShareDialog";
import { CloudMainShell, CloudTopbar } from "./CloudShell";
import { CloudSessionPanel } from "./CloudSessionPanel";
import { CloudSidebar } from "./CloudSidebar";
import {
  initialGitHubCapability,
  type GitHubCapability,
  initialProviderCapability,
  type ProviderCapability,
} from "./cloud-ui-types";

type CloudView = "board" | "settings";

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
  const [view, setView] = useState<CloudView>("board");
  const [settingsTarget, setSettingsTarget] = useState<
    "organization" | "providers"
  >("organization");
  const [commandOpen, setCommandOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [shareProject, setShareProject] = useState<Project | null>(null);
  const [github, setGitHub] = useState<GitHubCapability>(
    initialGitHubCapability,
  );
  const [githubBusy, setGitHubBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderCapability>(
    initialProviderCapability,
  );
  const [providerBusy, setProviderBusy] = useState(false);
  const organizationRequest = useRef(0);
  const githubRequest = useRef(0);
  const providerRequest = useRef(0);

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
        setSessions(sessionPage.items);
        setSelectedProjectId((current) =>
          current && projectPage.items.some(({ id }) => id === current)
            ? current
            : (projectPage.items[0]?.id ?? null),
        );
        void loadGitHub(orgId);
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
    [client, loadGitHub],
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
          setError("Your account has no active organization memberships.");
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
    const settings = new URLSearchParams(window.location.search).get("settings");
    if (settings === "providers") {
      setSettingsTarget("providers");
      setView("settings");
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

  const startGitHubInstallation = async () => {
    setGitHubBusy(true);
    setError("");
    try {
      const attempt = await client.startGitHubInstallation(organizationId);
      const popup = window.open(
        attempt.installationUrl,
        "ao-github-install",
        "popup,width=900,height=760",
      );
      if (!popup) {
        window.location.assign(attempt.installationUrl);
        return;
      }
      setGitHubBusy(false);
      const refresh = window.setInterval(() => {
        if (!popup.closed) return;
        window.clearInterval(refresh);
        void loadGitHub(organizationId);
      }, 500);
    } catch (cause) {
      handleLoadError(cause, setError);
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
      <div className="grid h-full grid-cols-[240px_minmax(0,1fr)]">
        <CloudSidebar
          account={account}
          onNewProject={() => setNewProjectOpen(true)}
          onOpenCommand={() => setCommandOpen(true)}
          onOpenSettings={() => {
            setSettingsTarget("organization");
            setView("settings");
            setSelectedSessionId(null);
          }}
          onSelectOrganization={(id) => {
            setOrganizationId(id);
            setSelectedProjectId(null);
            setSelectedSessionId(null);
            void loadOrganization(id);
          }}
          onSelectProject={(id) => {
            setView("board");
            setSelectedProjectId(id);
            setSelectedSessionId(null);
          }}
          onSelectSession={(id) => {
            setView("board");
            const session = sessions.find((item) => item.id === id);
            if (session) setSelectedProjectId(session.projectId);
            setSelectedSessionId(id);
          }}
          onShareProject={setShareProject}
          projects={projects}
          selectedOrganizationId={organizationId}
          selectedProjectId={selectedProjectId}
          selectedSessionId={selectedSessionId}
          sessions={sessions}
        />
        <CloudMainShell>
          {view === "settings" ? (
            <div className="relative min-h-0 flex-1">
              {error ? (
                <div
                  className="absolute inset-x-4 top-4 z-20 rounded-md border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-xs text-[var(--color-error)]"
                  role="alert"
                >
                  {error}
                </div>
              ) : null}
              <CloudSettings
                account={account}
                busy={githubBusy}
                github={github}
                initialPanel={settingsTarget}
                onConnectAgent={connectAgentProvider}
                onDisconnectAgent={disconnectAgentProvider}
                onBack={() => setView("board")}
                onDisconnectGitHub={disconnectGitHubInstallation}
                onSelectOrganization={(id) => {
                  setOrganizationId(id);
                  setSelectedProjectId(null);
                  setSelectedSessionId(null);
                  void loadOrganization(id);
                }}
                onStartGitHub={startGitHubInstallation}
                onSyncGitHub={syncGitHubInstallation}
                providerBusy={providerBusy}
                providers={providers}
                selectedOrganizationId={organizationId}
              />
            </div>
          ) : (
            <>
              <CloudTopbar title={selectedProject?.displayName ?? "All projects"} />
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
                    onSelectSession={setSelectedSessionId}
                    sessions={visibleSessions}
                  />
                )}
                {selectedSession ? (
                  <CloudSessionPanel
                    onClose={() => setSelectedSessionId(null)}
                    organizationId={organizationId}
                    session={selectedSession}
                  />
                ) : null}
              </div>
            </>
          )}
        </CloudMainShell>
      </div>
      {commandOpen ? (
        <CloudSearch
          onClose={() => setCommandOpen(false)}
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
          projects={projects}
          sessions={sessions}
        />
      ) : null}
      {newProjectOpen ? (
        <NewProjectDialog
          github={github}
          onClose={() => setNewProjectOpen(false)}
          onCreateFromGitHub={createProjectFromGitHub}
          onOpenProviderSettings={() => {
            setNewProjectOpen(false);
            setSettingsTarget("providers");
            setView("settings");
          }}
        />
      ) : null}
      {shareProject ? (
        <CloudShareDialog
          onClose={() => setShareProject(null)}
          project={shareProject}
          sessions={sessions.filter(
            ({ projectId }) => projectId === shareProject.id,
          )}
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
  onClose,
  onSelectProject,
  onSelectSession,
  projects,
  sessions,
}: {
  onClose: () => void;
  onSelectProject: (id: string) => void;
  onSelectSession: (id: string) => void;
  projects: Project[];
  sessions: Session[];
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const filteredProjects = projects.filter(({ displayName, repositoryUrl }) =>
    `${displayName} ${repositoryUrl}`.toLowerCase().includes(normalized),
  );
  const filteredSessions = sessions.filter(({ displayName, branch }) =>
    `${displayName} ${branch}`.toLowerCase().includes(normalized),
  );
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[14vh]"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        aria-label="Search workspace"
        aria-modal="true"
        className="w-full max-w-[680px] overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] shadow-2xl"
        role="dialog"
      >
        <div className="flex items-center gap-3 border-b border-[var(--color-border-strong)] px-4 py-3">
          <Search className="size-4 text-[var(--color-text-passive)]" />
          <input
            aria-label="Search"
            autoFocus
            className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-text-passive)]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects and sessions…"
            value={query}
          />
          <button aria-label="Close search" onClick={onClose} type="button">
            <X className="size-4 text-[var(--color-text-passive)]" />
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {[...filteredProjects, ...filteredSessions].length === 0 ? (
            <p className="p-6 text-center text-xs text-[var(--color-text-passive)]">
              No matching projects or sessions.
            </p>
          ) : null}
          {filteredProjects.map((project) => (
            <SearchResult
              detail={project.repositoryUrl}
              key={project.id}
              label={project.displayName}
              onClick={() => onSelectProject(project.id)}
              type="Project"
            />
          ))}
          {filteredSessions.map((session) => (
            <SearchResult
              detail={session.branch}
              key={session.id}
              label={session.displayName}
              onClick={() => onSelectSession(session.id)}
              type="Session"
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function SearchResult({
  detail,
  label,
  onClick,
  type,
}: {
  detail: string;
  label: string;
  onClick: () => void;
  type: string;
}) {
  return (
    <button
      className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-[var(--color-interactive-hover)]"
      onClick={onClick}
      type="button"
    >
      <span className="w-14 shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--color-text-passive)]">
        {type}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <span className="max-w-[45%] truncate text-xs text-[var(--color-text-passive)]">
        {detail}
      </span>
    </button>
  );
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
