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
import {
  ConfirmProvider,
  useConfirm,
} from "@/components/ui/confirm-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  browserCloudClient,
  consumePendingShareRedemption,
  newIdempotencyKey,
} from "@/lib/cloud-client";
import { CloudBoard } from "./CloudBoard";
import {
  AddAgentToProjectDialog,
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
import type {
  CreateInvitationInput,
  OrganizationInvitation,
  ProjectShareLink,
  ProjectShareModeCap,
  SharedProject,
} from "./share-types";
import {
  initialGitHubCapability,
  initialGitHubUserCapability,
  initialMembersCapability,
  type GitHubCapability,
  type GitHubUserCapability,
  type MembersCapability,
  initialProviderCapability,
  type ProviderCapability,
} from "./cloud-ui-types";

type AgentProvider = "claude-code" | "codex" | "cursor";

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
  const [addAgentProject, setAddAgentProject] = useState<Project | null>(null);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(null);
  const [projectSettings, setProjectSettings] = useState<Project | null>(null);
  const [projectSettingsBusy, setProjectSettingsBusy] = useState(false);
  const [shareProject, setShareProject] = useState<Project | null>(null);
  const [shareLinks, setShareLinks] = useState<ProjectShareLink[]>([]);
  const [shareGrants, setShareGrants] = useState<SharedProject[]>([]);
  const [shareLinksBusy, setShareLinksBusy] = useState(false);
  const [sharedProjects, setSharedProjects] = useState<SharedProject[]>([]);
  const [sharedProjectSessions, setSharedProjectSessions] = useState<Record<string, Session[]>>({});
  const sharedProjectSessionsRef = useRef(sharedProjectSessions);
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
  const [userProviders, setUserProviders] = useState<ProviderCapability>(
    initialProviderCapability,
  );
  const [userProviderBusy, setUserProviderBusy] = useState(false);
  const [members, setMembers] = useState<MembersCapability>(initialMembersCapability);
  const [membersBusy, setMembersBusy] = useState(false);
  const [incomingInvitations, setIncomingInvitations] = useState<OrganizationInvitation[]>([]);
  const organizationRequest = useRef(0);
  const githubRequest = useRef(0);
  const providerRequest = useRef(0);
  const membersRequest = useRef(0);
  const deletingSessionIds = useRef(new Set<string>());
  const [previewUi, setPreviewUi] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    sharedProjectSessionsRef.current = sharedProjectSessions;
  }, [sharedProjectSessions]);

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
          .then(async (connections) => {
            if (providerRequest.current !== providerLoad) return;
            setProviders({ status: "available", connections });
            const legacyProviders = connections
              .filter(({ label, validationState }) => label === "default" && validationState === "valid")
              .map(({ provider }) => provider)
              .filter((provider): provider is AgentProvider =>
                provider === "claude-code" || provider === "codex" || provider === "cursor",
              );
            if (legacyProviders.length > 0) {
              await Promise.allSettled(
                legacyProviders.map((provider) => client.promoteProviderConnection(orgId, provider)),
              );
              const personalConnections = await client.listUserProviderConnections();
              setUserProviders({ status: "available", connections: personalConnections });
            }
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
              message: cause instanceof Error ? cause.message : "Could not load workspace members.",
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
    } catch {}
  }, [client]);

  const loadUserProviders = useCallback(async () => {
    try {
      const connections = await client.listUserProviderConnections();
      setUserProviders({ status: "available", connections });
    } catch (cause) {
      setUserProviders({
        status: "error",
        connections: [],
        message: cause instanceof Error ? cause.message : "Could not load personal coding agents.",
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
        const shareParams = new URLSearchParams(window.location.search);
        const shareOrg = shareParams.get("shareOrg");
        const shareToken = shareParams.get("share");
        if (shareOrg && shareToken) {
          shareParams.delete("shareOrg");
          shareParams.delete("share");
          const query = shareParams.toString();
          window.history.replaceState({}, "", `/app${query ? `?${query}` : ""}`);
        }
        const pending =
          shareOrg && shareToken
            ? { orgId: shareOrg, token: shareToken }
            : consumePendingShareRedemption();
        if (pending) {
          void (async () => {
            try {
              const { shared } = await client.redeemProjectShareLink(pending);
              const sharedSessions = await client.listSharedProjectSessions(
                shared.project.orgId,
                shared.project.id,
              );
              if (!active) return;
              setSharedProjects((current) => [
                shared,
                ...current.filter(
                  (item) => item.project.id !== shared.project.id,
                ),
              ]);
              setSharedProjectSessions((current) => ({
                ...current,
                [shared.project.id]: sharedSessions,
              }));
              const targetSession =
                sharedSessions.find(({ id }) => id === shared.sessionId) ??
                sharedSessions[0];
              if (targetSession) {
                const response = await client.getSession(
                  shared.project.orgId,
                  targetSession.id,
                );
                if (!active) return;
                setSelectedSessionId(null);
                setSharedSessionOrgId(shared.project.orgId);
                setSharedSession(response.session);
              }
            } catch {}
          })();
        }
        void loadSharedProjects();
        void loadUserProviders();
        void client.listMyInvitations().then(setIncomingInvitations).catch(() => {});
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
    let active = true;
    let refreshing = false;
    const refreshShared = async () => {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      try {
        const items = await client.listSharedProjects();
        if (!active) return;
        setSharedProjects(items);
        const expandedProjectIds = new Set(
          Object.keys(sharedProjectSessionsRef.current),
        );
        const expandedShares = new Map(
          items
            .filter((shared) => expandedProjectIds.has(shared.project.id))
            .map((shared) => [shared.project.id, shared]),
        );
        await Promise.all(
          Array.from(expandedShares.values()).map(async (shared) => {
            try {
              const sessionItems = await client.listSharedProjectSessions(
                shared.project.orgId,
                shared.project.id,
              );
              if (active) {
                setSharedProjectSessions((current) => ({
                  ...current,
                  [shared.project.id]: sessionItems,
                }));
              }
            } catch {}
          }),
        );
      } catch {
      } finally {
        refreshing = false;
      }
    };
    const interval = window.setInterval(() => void refreshShared(), 3_000);
    const onVisibility = () => void refreshShared();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client]);

  useEffect(() => {
    const settings = new URLSearchParams(window.location.search).get("settings");
    if (settings === "providers") {
      setSettingsTarget("providers");
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

  const createProjectFromGitHub = async (
    repository: GitHubRepository,
    harness: LocalAgentInput["harness"],
  ) => {
    const response = await client.createProjectFromGitHub(
      organizationId,
      { githubRepositoryId: repository.githubRepositoryId },
      { idempotencyKey: newIdempotencyKey("github-project") },
    );
    const sessionResponse = await client.createSession(
      organizationId,
      {
        projectId: response.project.id,
        kind: "orchestrator",
        harness,
        displayName: localAgentName(harness),
        prompt: "",
        mode: "trusted",
        deniedCommands: [],
      },
      { idempotencyKey: newIdempotencyKey("github-orchestrator") },
    );
    setProjects((current) => [...current, response.project]);
    setSessions((current) => [...current, sessionResponse.session]);
    setSelectedProjectId(response.project.id);
    setSelectedSessionId(sessionResponse.session.id);
  };

  const createScratchWork = async (
    input: LocalAgentInput,
    classification:
      | "orchestrator-project"
      | "standalone-agent"
      | "independent-project",
  ) => {
    const suffix = crypto.randomUUID();
    const kind =
      classification === "orchestrator-project" ? "orchestrator" : "worker";
    const projectResponse = await client.createProject(
      organizationId,
      {
        displayName: input.displayName,
        repositoryUrl: `https://scratch.ao.local/${suffix}`,
        defaultBranch: "main",
        config: {
          source:
            classification === "standalone-agent"
              ? "standalone-agent"
              : classification === "independent-project"
                ? "scratch-independent"
                : "scratch",
          scratch: true,
          standalone: classification === "standalone-agent",
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
          classification === "orchestrator-project"
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
    if (input.noRepository) {
      await createScratchWork(input, "independent-project");
      return;
    }
    if (!input.githubInstallationId) {
      await createScratchWork(input, "orchestrator-project");
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

  const addAgentToProject = async (
    project: Project,
    input: LocalAgentInput,
  ) => {
    await createSessionInProject(project.id, input);
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

  const connectGitHubUser = async () => {
    const attempt = await client.startGitHubUserAuthorization();
    const popup = window.open(
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
    return popup;
  };

  const connectGitHubOrganization = async (existingPopup?: Window | null) => {
    const before = new Map(
      github.status === "available"
        ? github.installations.map(({ githubInstallationId, updatedAt }) => [
            githubInstallationId,
            updatedAt,
          ])
        : [],
    );
    const beforeUserInstallations = new Map(
      githubUser.connection.installations.map((installation) => [
        installation.githubInstallationId,
        [
          installation.repositorySelection,
          String(installation.canCreateRepository),
          installation.unavailableReason ?? "",
        ].join(":"),
      ]),
    );
    const attempt = await client.startGitHubInstallation(organizationId);
    let popup = existingPopup ?? null;
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
    let connectedInstallation: GitHubInstallation | undefined;
    let claimedExistingInstallation = false;
    while (Date.now() < deadline) {
      const installations = await client.listGitHubInstallations(organizationId);
      connectedInstallation = installations.find(
        ({ githubInstallationId, status, updatedAt }) =>
          status === "active" &&
          (!before.has(githubInstallationId) ||
            before.get(githubInstallationId) !== updatedAt),
      );
      if (connectedInstallation) {
        break;
      }
      const userConnection = await client.getGitHubUserConnection();
      const changedExistingInstallation = userConnection.installations.find(
        (installation) =>
          beforeUserInstallations.get(installation.githubInstallationId) !==
            [
              installation.repositorySelection,
              String(installation.canCreateRepository),
              installation.unavailableReason ?? "",
            ].join(":"),
      );
      if (changedExistingInstallation) {
        setGitHubUser({ status: "available", connection: userConnection });
        if (changedExistingInstallation.accountType === "Organization") {
          const claimed = await client.claimGitHubInstallation(
            organizationId,
            changedExistingInstallation.githubInstallationId,
          );
          connectedInstallation = claimed.installation;
          claimedExistingInstallation = true;
          break;
        }
        popup.close();
        await Promise.all([loadGitHubUser(), loadGitHub(organizationId)]);
        return;
      }
      if (popup.closed) {
        await Promise.all([loadGitHubUser(), loadGitHub(organizationId)]);
        return;
      }
      await delay(500);
    }
    if (!connectedInstallation) {
      throw new Error("The AO GitHub App installation did not complete.");
    }
    if (!claimedExistingInstallation) {
      await client.syncGitHubInstallation(
        organizationId,
        connectedInstallation.id,
      );
    }
    popup.close();
    await Promise.all([loadGitHubUser(), loadGitHub(organizationId)]);
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
    try {
      let popup: Window | null = null;
      if (!githubUser.connection.connected) {
        popup = await connectGitHubUser();
      }
      const hasInstalls =
        github.status === "available" && github.installations.length > 0;
      if (!hasInstalls) {
        await connectGitHubOrganization(popup);
        return;
      }
      popup?.close();
      await loadGitHubUser();
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setGitHubBusy(false);
    }
  };

  const startGitHubOrganizationInstall = async () => {
    if (
      github.status === "auth-required" ||
      githubUser.status === "auth-required"
    ) {
      window.location.assign("/github-sign-in");
      return;
    }
    setGitHubBusy(true);
    setError("");
    try {
      await connectGitHubOrganization();
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setGitHubBusy(false);
    }
  };

  const claimGitHubOrganization = async (githubInstallationId: string) => {
    setGitHubBusy(true);
    setError("");
    try {
      await client.claimGitHubInstallation(
        organizationId,
        githubInstallationId,
      );
      await Promise.all([loadGitHubUser(), loadGitHub(organizationId)]);
    } catch (cause) {
      handleLoadError(cause, setError);
    } finally {
      setGitHubBusy(false);
    }
  };

  const syncGitHubUser = async () => {
    setGitHubBusy(true);
    setError("");
    try {
      await loadGitHubUser();
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

  const connectUserAgentProvider = async (
    provider: "claude-code" | "codex" | "cursor",
    input: PutAgentProviderConnectionInput,
  ) => {
    setUserProviderBusy(true);
    setError("");
    try {
      const response = await client.putUserProviderConnection(provider, input);
      setUserProviders((current) => ({
        status: "available",
        connections: [
          ...current.connections.filter((connection) => connection.provider !== provider),
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

  const disconnectUserAgentProvider = async (connection: RedactedProviderConnection) => {
    const provider = connection.provider;
    if (provider !== "claude-code" && provider !== "codex" && provider !== "cursor") return;
    setUserProviderBusy(true);
    setError("");
    try {
      await client.deleteUserProviderConnection(provider);
      setUserProviders((current) => ({
        ...current,
        connections: current.connections.filter((item) => item.id !== connection.id),
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
      const response = await client.createOrgInvitation(organizationId, input);
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

  const createWorkspace = async (displayName: string) => {
    const { organization } = await client.createOrganization({ displayName });
    setAccount((current) => current ? {
      ...current,
      organizations: [...current.organizations, organization],
    } : current);
    setOrganizationId(organization.id);
    setSelectedProjectId(null);
    setSelectedSessionId(null);
    await loadOrganization(organization.id);
  };

  const updateMemberRole = async (
    userId: string,
    role: "owner" | "admin" | "member",
  ) => {
    setMembersBusy(true);
    try {
      const { member } = await client.updateOrgMemberRole(
        organizationId,
        userId,
        role,
      );
      setMembers((current) => ({
        ...current,
        members: current.members.map((item) =>
          item.userId === userId ? member : item,
        ),
      }));
      setAccount((current) => current ? {
        ...current,
        organizations: current.organizations.map((organization) =>
          organization.id === organizationId && userId === current.user.id
            ? { ...organization, role }
            : organization,
        ),
      } : current);
    } finally {
      setMembersBusy(false);
    }
  };

  const acceptInvitation = async (invitation: OrganizationInvitation) => {
    const { organization } = await client.acceptOrgInvitation(invitation.orgId, invitation.id);
    setIncomingInvitations((current) => current.filter(({ id }) => id !== invitation.id));
    setAccount((current) => current ? {
      ...current,
      organizations: [...current.organizations, organization],
    } : current);
    setOrganizationId(organization.id);
    await loadOrganization(organization.id);
  };

  const declineInvitation = async (invitation: OrganizationInvitation) => {
    await client.declineOrgInvitation(invitation.orgId, invitation.id);
    setIncomingInvitations((current) => current.filter(({ id }) => id !== invitation.id));
  };

  const expandSharedProject = async (shared: SharedProject) => {
    if (sharedProjectSessions[shared.project.id]) return;
    try {
      const items = await client.listSharedProjectSessions(shared.project.orgId, shared.project.id);
      setSharedProjectSessions((current) => ({ ...current, [shared.project.id]: items }));
    } catch (cause) {
      handleLoadError(cause, setError);
    }
  };

  const selectSharedSession = async (shared: SharedProject, sessionId: string) => {
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
      const remaining = sessions.filter(({ id }) => id !== session.id);
      setSessions(remaining);
      if (selectedSessionId === session.id) setSelectedSessionId(null);
      if (!remaining.some(({ projectId }) => projectId === session.projectId)) {
        const project = projects.find(({ id }) => id === session.projectId);
        if (project) await deleteProject(project);
      }
    } catch (cause) {
      handleLoadError(cause, setError);
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
        current.map((item) => item.id === link.id ? { ...item, status: "revoked" } : item),
      );
    } finally {
      setShareLinksBusy(false);
    }
  };

  const revokeShareGrant = async (grant: SharedProject) => {
    if (!shareProject) return;
    setShareLinksBusy(true);
    try {
      await client.revokeProjectShareGrant(organizationId, shareProject.id, grant.grant.id);
      setShareGrants((current) => current.filter((item) => item.grant.id !== grant.grant.id));
    } finally {
      setShareLinksBusy(false);
    }
  };

  const updateShareGrant = async (
    grant: SharedProject,
    input: {
      role: "viewer" | "editor";
      modeCap: ProjectShareModeCap;
      sessionId: string;
    },
  ) => {
    if (!shareProject) return;
    setShareLinksBusy(true);
    try {
      const response = await client.updateProjectShareGrant(
        organizationId,
        shareProject.id,
        grant.grant.id,
        input,
      );
      setShareGrants((current) => current.map((item) =>
        item.grant.id === grant.grant.id ? response.grant : item,
      ));
    } finally {
      setShareLinksBusy(false);
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
  const activeSessionOrgId = sharedSession ? sharedSessionOrgId : organizationId;

  return (
    <main
      data-testid="cloud-workspace"
      className="fixed inset-0 h-dvh overflow-hidden bg-[var(--color-bg-primary)] font-sans tracking-normal text-[var(--color-text-primary)] [color-scheme:dark] [&_*]:[scrollbar-color:rgb(255_255_255_/_12%)_transparent] [&_*]:[scrollbar-width:thin]"
    >
      <div className={`grid h-full grid-cols-1 ${sidebarCollapsed ? "lg:grid-cols-[0px_minmax(0,1fr)]" : "lg:grid-cols-[240px_minmax(0,1fr)]"} transition-[grid-template-columns] duration-200 ease-out`}>
        {previewUi && mobileNavOpen ? <button type="button" aria-label="Close navigation overlay" className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setMobileNavOpen(false)} /> : null}
        <CloudSidebar
          account={account}
          onAddAgentToProject={setAddAgentProject}
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
            setSelectedProjectId(id);
            setSelectedSessionId(null);
            setSharedSession(null);
          }}
          onSelectSession={(id) => {
            const session = sessions.find((item) => item.id === id);
            if (session) setSelectedProjectId(session.projectId);
            setSelectedSessionId(id);
            setSharedSession(null);
          }}
          onExpandSharedProject={(shared) => void expandSharedProject(shared)}
          onSelectSharedSession={(shared, sessionId) => void selectSharedSession(shared, sessionId)}
          onProjectSettings={setProjectSettings}
          onShareProject={(project) => void openShareDialog(project)}
          projects={projects}
          selectedOrganizationId={organizationId}
          selectedProjectId={selectedProjectId}
          selectedSessionId={activeSession?.id ?? null}
          sessions={sessions}
          sharedProjectSessions={sharedProjectSessions}
          sharedProjects={sharedProjects}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          parity={previewUi}
        />
        <CloudMainShell parity={previewUi} sidebarCollapsed={sidebarCollapsed}>
          {activeSession ? (
            <CloudSessionWorkspace
              onClose={() => { setSelectedSessionId(null); setSharedSession(null); }}
              onDelete={() => { if (!sharedSession) void deleteSession(activeSession); setSelectedSessionId(null); setSharedSession(null); }}
              onNewTask={() => { if (!sharedSession) setNewSessionProjectId(activeSession.projectId); }}
              onShare={() => {
                const project = projects.find((p) => p.id === activeSession.projectId);
                if (project) void openShareDialog(project);
              }}
              onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
              sidebarOpen={!sidebarCollapsed}
              organizationId={activeSessionOrgId}
              session={activeSession}
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
                onOrchestrator={
                  selectedProject && !selectedProject.config?.scratch
                    ? () => setNewSessionProjectId(selectedProject.id)
                    : undefined
                }
                onShare={selectedProject ? () => void openShareDialog(selectedProject) : undefined}
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
                    organizationId={organizationId}
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
          onConnectGitHubOrganization={startGitHubOrganizationInstall}
          onClaimGitHubOrganization={claimGitHubOrganization}
          onConnectUserAgent={connectUserAgentProvider}
          onDisconnectUserAgent={disconnectUserAgentProvider}
          onBack={() => setSettingsOpen(false)}
          onDisconnectGitHub={disconnectGitHubInstallation}
          onDisconnectGitHubUser={disconnectGitHubUser}
          onInviteMember={inviteMember}
          incomingInvitations={incomingInvitations}
          onAcceptInvitation={acceptInvitation}
          onDeclineInvitation={declineInvitation}
          onUpdateMemberRole={updateMemberRole}
          onRevokeInvitation={revokeInvitation}
          onSelectOrganization={(id) => {
            setOrganizationId(id);
            setSelectedProjectId(null);
            setSelectedSessionId(null);
            void loadOrganization(id);
          }}
          onSyncGitHub={syncGitHubInstallation}
          onSyncGitHubUser={syncGitHubUser}
          members={members}
          membersBusy={membersBusy}
          selectedOrganizationId={organizationId}
          userProviderBusy={userProviderBusy}
          userProviders={userProviders}
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
        connectedProviders={connectedProviderNames(providers, userProviders)}
        github={github}
        githubUser={githubUser}
        onClose={() => setNewProjectOpen(false)}
        onCreateFromGitHub={createProjectFromGitHub}
        onCreateScratchProject={createScratchProject}
        onCreateStandalone={(input) => createScratchWork(input, "standalone-agent")}
        onOpenProviderSettings={() => {
          setNewProjectOpen(false);
          setSettingsTarget("providers");
          setSettingsOpen(true);
        }}
        open={newProjectOpen}
      />
      {addAgentProject ? (
        <AddAgentToProjectDialog
          onClose={() => setAddAgentProject(null)}
          onSubmit={(input) => addAgentToProject(addAgentProject, input)}
          projectName={addAgentProject.displayName}
        />
      ) : null}
      <CloudCreateWorkspaceDialog
        open={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        onCreate={createWorkspace}
      />
      <CloudNewSessionDialog
        open={newSessionProjectId !== null}
        projectName={projects.find((p) => p.id === newSessionProjectId)?.displayName ?? ""}
        connectedProviders={connectedProviderNames(providers, userProviders)}
        onClose={() => setNewSessionProjectId(null)}
        onCreate={(input) => {
          if (!newSessionProjectId) return Promise.resolve();
          return createSessionInProject(newSessionProjectId, input);
        }}
      />
      {shareProject ? (
        <CloudShareDialog
          busy={shareLinksBusy}
          grants={shareGrants}
          links={shareLinks}
          onClose={() => setShareProject(null)}
          onCreate={createShareLink}
          onRevoke={revokeShareLink}
          onRevokeGrant={revokeShareGrant}
          onUpdateGrant={updateShareGrant}
          open
          project={shareProject}
          sessions={sessions.filter(({ projectId }) => projectId === shareProject.id)}
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

function CloudWorkspaceWithConfirm() {
  return (
    <ConfirmProvider>
      <CloudWorkspace />
    </ConfirmProvider>
  );
}

export default CloudWorkspaceWithConfirm;

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

function connectedProviderNames(
  workspaceProviders: ProviderCapability,
  userProviders: ProviderCapability,
): string[] {
  const connected = new Set<string>();
  if (workspaceProviders.status === "available") {
    for (const connection of workspaceProviders.connections) {
      if (connection.validationState === "valid") connected.add(connection.provider);
    }
  }
  if (userProviders.status === "available") {
    for (const connection of userProviders.connections) {
      if (connection.validationState === "valid") connected.add(connection.provider);
    }
  }
  return Array.from(connected);
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
