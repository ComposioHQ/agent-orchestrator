"use client";

import {
  CloudApiError,
  type CreateInvitationInput,
  type CurrentAccount,
  type GitHubInstallation,
  type GitHubRepository,
  type OrganizationInvitation,
  type Project,
  type ProjectShareLink,
  type ProjectShareModeCap,
  type PutAgentProviderConnectionInput,
  type RedactedProviderConnection,
  type Session,
  type SharedProject,
  type UpdateProjectInput,
} from "@aoagents/cloud-client";
import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  browserCloudClient,
  consumePendingShareRedemption,
  newIdempotencyKey,
} from "@/lib/cloud-client";
import { CloudBoard } from "./CloudBoard";
import {
  NewProjectDialog,
  type LocalAgentInput,
  type ScratchProjectInput,
} from "./CloudDialogs";
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
  initialMembersCapability,
  type MembersCapability,
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
  const [projectSettings, setProjectSettings] = useState<Project | null>(null);
  const [projectSettingsBusy, setProjectSettingsBusy] = useState(false);
  const [shareProject, setShareProject] = useState<Project | null>(null);
  const [shareLinks, setShareLinks] = useState<ProjectShareLink[]>([]);
  const [shareGrants, setShareGrants] = useState<SharedProject[]>([]);
  const [shareLinksBusy, setShareLinksBusy] = useState(false);
  const [sharedProjects, setSharedProjects] = useState<SharedProject[]>([]);
  const [sharedProjectSessions, setSharedProjectSessions] = useState<
    Record<string, Session[]>
  >({});
  const [sharedSession, setSharedSession] = useState<Session | null>(null);
  const [sharedSessionOrgId, setSharedSessionOrgId] = useState("");
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
  const [userProviders, setUserProviders] = useState<ProviderCapability>(
    initialProviderCapability,
  );
  const [userProviderBusy, setUserProviderBusy] = useState(false);
  const [members, setMembers] = useState<MembersCapability>(
    initialMembersCapability,
  );
  const [membersBusy, setMembersBusy] = useState(false);
  const organizationRequest = useRef(0);
  const githubRequest = useRef(0);
  const providerRequest = useRef(0);
  const membersRequest = useRef(0);
  const deletingSessionIds = useRef(new Set<string>());

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
        const membersLoad = membersRequest.current + 1;
        membersRequest.current = membersLoad;
        setMembers(initialMembersCapability);
        void Promise.all([
          client.listOrgMembers(orgId),
          client.listOrgInvitations(orgId).catch(() => []),
        ])
          .then(([orgMembers, invitations]) => {
            if (membersRequest.current !== membersLoad) return;
            setMembers({ status: "available", members: orgMembers, invitations });
          })
          .catch((cause) => {
            if (membersRequest.current !== membersLoad) return;
            setMembers({
              status: "error",
              members: [],
              invitations: [],
              message:
                cause instanceof Error
                  ? cause.message
                  : "Could not load organization members.",
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

  const loadSharedProjects = useCallback(async () => {
    try {
      setSharedProjects(await client.listSharedProjects());
    } catch {
      // "Shared with me" is a courtesy sidebar section, not the primary
      // workspace — a failure here should not block or error the rest of
      // the app.
    }
  }, [client]);

  const loadUserProviders = useCallback(async () => {
    try {
      const connections = await client.listUserProviderConnections();
      setUserProviders({ status: "available", connections });
    } catch (cause) {
      setUserProviders({
        status: "error",
        connections: [],
        message:
          cause instanceof Error
            ? cause.message
            : "Could not load your personal provider connections.",
      });
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    void client
      .getCurrentAccount()
      .then(async (value) => {
        if (!active) return;
        setAccount(value);
        const pending = consumePendingShareRedemption();
        if (pending) {
          try {
            await client.redeemProjectShareLink(pending);
          } catch {
            // Surfaced organically: the project just won't appear below.
          }
        }
        void loadSharedProjects();
        void loadUserProviders();
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
  }, [client, loadOrganization, loadSharedProjects, loadUserProviders]);

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

  const createScratchProject = async (input: ScratchProjectInput) => {
    if (!input.githubInstallationId) {
      // No repo means there's nothing for an orchestrator to check workers
      // out of, so the orchestrator/worker-VM model doesn't apply here —
      // treat it the same as a standalone agent (config.standalone: true),
      // which is exactly what lets more agents be added into the same
      // project afterward without implying a fleet under one orchestrator.
      await createScratchWork(input, "worker");
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

  const connectUserAgentProvider = async (
    provider: "claude-code" | "codex" | "cursor",
    input: PutAgentProviderConnectionInput,
  ) => {
    setUserProviderBusy(true);
    setError("");
    try {
      const response = await client.putUserProviderConnection(
        provider,
        input,
      );
      setUserProviders((current) => ({
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
      setUserProviderBusy(false);
    }
  };

  const disconnectUserAgentProvider = async (
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
    setUserProviderBusy(true);
    setError("");
    try {
      await client.deleteUserProviderConnection(provider);
      setUserProviders((current) => ({
        ...current,
        connections: current.connections.filter(
          (item) => item.id !== connection.id,
        ),
      }));
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setUserProviderBusy(false);
    }
  };

  const inviteMember = async (input: CreateInvitationInput) => {
    setMembersBusy(true);
    setError("");
    try {
      const response = await client.createOrgInvitation(
        organizationId,
        input,
      );
      setMembers((current) => ({
        ...current,
        invitations: [response.invitation, ...current.invitations],
      }));
    } catch (cause) {
      handleLoadError(cause, setError);
      throw cause;
    } finally {
      setMembersBusy(false);
    }
  };

  const revokeInvitation = async (invitation: OrganizationInvitation) => {
    setMembersBusy(true);
    setError("");
    try {
      await client.revokeOrgInvitation(organizationId, invitation.id);
      setMembers((current) => ({
        ...current,
        invitations: current.invitations.map((item) =>
          item.id === invitation.id ? { ...item, status: "revoked" } : item,
        ),
      }));
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setMembersBusy(false);
    }
  };

  const openShareDialog = async (project: Project) => {
    setShareProject(project);
    setShareLinks([]);
    setShareGrants([]);
    try {
      const [links, grants] = await Promise.all([
        client.listProjectShareLinks(organizationId, project.id),
        client.listProjectShareGrants(organizationId, project.id),
      ]);
      setShareLinks(links);
      setShareGrants(grants);
    } catch (cause) {
      handleLoadError(cause, setError);
    }
  };

  const createShareLink = async (input: {
    accessScope: "anyone" | "restricted";
    recipients: string[];
    modeCap: ProjectShareModeCap;
  }): Promise<ProjectShareLink> => {
    if (!shareProject) throw new Error("No project selected to share.");
    setShareLinksBusy(true);
    try {
      const readOnly = input.modeCap === "read-only";
      const response = await client.createProjectShareLink(
        organizationId,
        shareProject.id,
        {
          role: readOnly ? "viewer" : "editor",
          interaction: readOnly ? "view" : "interact",
          accessScope: input.accessScope,
          recipients: input.recipients,
          modeCap: input.modeCap,
        },
      );
      setShareLinks((current) => [response.link, ...current]);
      return response.link;
    } finally {
      setShareLinksBusy(false);
    }
  };

  const revokeShareLink = async (link: ProjectShareLink) => {
    if (!shareProject) return;
    setShareLinksBusy(true);
    try {
      await client.revokeProjectShareLink(organizationId, shareProject.id, link.id);
      setShareLinks((current) =>
        current.map((item) =>
          item.id === link.id ? { ...item, status: "revoked" } : item,
        ),
      );
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setShareLinksBusy(false);
    }
  };

  const revokeShareGrant = async (grant: SharedProject) => {
    if (!shareProject) return;
    setShareLinksBusy(true);
    try {
      await client.revokeProjectShareGrant(organizationId, shareProject.id, grant.grant.id);
      setShareGrants((current) =>
        current.filter((item) => item.grant.id !== grant.grant.id),
      );
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setShareLinksBusy(false);
    }
  };

  const expandSharedProject = async (shared: SharedProject) => {
    if (sharedProjectSessions[shared.project.id]) return;
    try {
      const items = await client.listSharedProjectSessions(
        shared.project.orgId,
        shared.project.id,
      );
      setSharedProjectSessions((current) => ({
        ...current,
        [shared.project.id]: items,
      }));
    } catch (cause) {
      handleLoadError(cause, setError);
    }
  };

  const selectSharedSession = async (shared: SharedProject, sessionId: string) => {
    setView("board");
    setSelectedSessionId(null);
    try {
      const response = await client.getSession(shared.project.orgId, sessionId);
      setSharedSessionOrgId(shared.project.orgId);
      setSharedSession(response.session);
    } catch (cause) {
      handleLoadError(cause, setError);
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
  const activeSession = sharedSession ?? selectedSession;
  const activeOrgId = sharedSession ? sharedSessionOrgId : organizationId;

  return (
    <main
      data-testid="cloud-workspace"
      className="fixed inset-0 h-dvh overflow-hidden bg-[var(--color-bg-primary)] font-sans tracking-normal text-[var(--color-text-primary)] [color-scheme:dark] [&_*]:[scrollbar-color:rgb(255_255_255_/_12%)_transparent] [&_*]:[scrollbar-width:thin]"
    >
      <div className="grid h-full grid-cols-[240px_minmax(0,1fr)]">
        <CloudSidebar
          account={account}
          onDeleteSession={(session) => void deleteSession(session)}
          onNewProject={() => setNewProjectOpen(true)}
          onOpenCommand={() => setCommandOpen(true)}
          onOpenSettings={() => {
            setSettingsTarget("organization");
            setView("settings");
            setSelectedSessionId(null);
            setSharedSession(null);
          }}
          onSelectOrganization={(id) => {
            setOrganizationId(id);
            setSelectedProjectId(null);
            setSelectedSessionId(null);
            setSharedSession(null);
            void loadOrganization(id);
          }}
          onSelectProject={(id) => {
            setView("board");
            setSelectedProjectId(id);
            setSelectedSessionId(null);
            setSharedSession(null);
          }}
          onSelectSession={(id) => {
            setView("board");
            const session = sessions.find((item) => item.id === id);
            if (session) setSelectedProjectId(session.projectId);
            setSelectedSessionId(id);
            setSharedSession(null);
          }}
          onExpandSharedProject={expandSharedProject}
          onProjectSettings={setProjectSettings}
          onSelectSharedSession={selectSharedSession}
          onShareProject={(project) => void openShareDialog(project)}
          projects={projects}
          selectedOrganizationId={organizationId}
          selectedProjectId={selectedProjectId}
          selectedSessionId={sharedSession ? sharedSession.id : selectedSessionId}
          sessions={sessions}
          sharedProjectSessions={sharedProjectSessions}
          sharedProjects={sharedProjects}
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
                githubUser={githubUser}
                initialPanel={settingsTarget}
                members={members}
                membersBusy={membersBusy}
                onConnectGitHub={connectGitHub}
                onConnectAgent={connectAgentProvider}
                onConnectUserAgent={connectUserAgentProvider}
                onDisconnectAgent={disconnectAgentProvider}
                onDisconnectUserAgent={disconnectUserAgentProvider}
                onBack={() => setView("board")}
                onDisconnectGitHub={disconnectGitHubInstallation}
                onDisconnectGitHubUser={disconnectGitHubUser}
                onInviteMember={inviteMember}
                onRevokeInvitation={revokeInvitation}
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
                userProviderBusy={userProviderBusy}
                userProviders={userProviders}
              />
            </div>
          ) : (
            activeSession ? (
              <CloudSessionWorkspace
                onClose={() => {
                  setSelectedSessionId(null);
                  setSharedSession(null);
                }}
                organizationId={activeOrgId}
                session={activeSession}
              />
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
                      organizationId={organizationId}
                      sessions={visibleSessions}
                    />
                  )}
                </div>
              </>
            )
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
          githubUser={githubUser}
          onClose={() => setNewProjectOpen(false)}
          onCreateFromGitHub={createProjectFromGitHub}
          onCreateScratchProject={createScratchProject}
          onCreateStandalone={(input) => createScratchWork(input, "worker")}
          onOpenProviderSettings={() => {
            setNewProjectOpen(false);
            setSettingsTarget("providers");
            setView("settings");
          }}
        />
      ) : null}
      {shareProject ? (
        <CloudShareDialog
          busy={shareLinksBusy}
          grants={shareGrants}
          links={shareLinks}
          onClose={() => setShareProject(null)}
          onCreate={createShareLink}
          onRevoke={revokeShareLink}
          onRevokeGrant={revokeShareGrant}
          project={shareProject}
        />
      ) : null}
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
  const filteredProjects = projects.filter(
    (project) =>
      !isStandaloneProject(project) &&
      `${project.displayName} ${project.repositoryUrl}`
        .toLowerCase()
        .includes(normalized),
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
