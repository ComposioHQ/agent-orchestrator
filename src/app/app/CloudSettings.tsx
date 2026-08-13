"use client";

import type {
  CreateInvitationInput,
  CurrentAccount,
  GitHubInstallation,
  OrganizationInvitation,
  PutAgentProviderConnectionInput,
  RedactedProviderConnection,
} from "@aoagents/cloud-client";
import {
  Bell,
  Building2,
  ChevronLeft,
  GitFork,
  KeyRound,
  Mail,
  Plus,
  RefreshCw,
  Settings,
  Unplug,
  User,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import type {
  GitHubCapability,
  GitHubUserCapability,
  MembersCapability,
  ProviderCapability,
} from "./cloud-ui-types";

type SettingsPanel = "profile" | "notifications" | "organization" | "providers";
type AgentProvider = "claude-code" | "codex" | "cursor";

export function CloudSettings({
  account,
  busy,
  github,
  githubUser,
  initialPanel,
  members,
  membersBusy,
  onBack,
  onConnectGitHub,
  onConnectAgent,
  onDisconnectAgent,
  onDisconnectGitHub,
  onDisconnectGitHubUser,
  onConnectUserAgent,
  onDisconnectUserAgent,
  onInviteMember,
  onRevokeInvitation,
  onSelectOrganization,
  onSyncGitHub,
  providerBusy,
  providers,
  selectedOrganizationId,
  userProviderBusy,
  userProviders,
}: {
  account: CurrentAccount;
  busy: boolean;
  github: GitHubCapability;
  githubUser: GitHubUserCapability;
  initialPanel: "organization" | "providers";
  members: MembersCapability;
  membersBusy: boolean;
  onBack: () => void;
  onConnectGitHub: () => Promise<void>;
  onConnectAgent: (
    provider: AgentProvider,
    input: PutAgentProviderConnectionInput,
  ) => Promise<void>;
  onDisconnectAgent: (
    connection: RedactedProviderConnection,
  ) => Promise<void>;
  onDisconnectGitHub: (installation: GitHubInstallation) => Promise<void>;
  onDisconnectGitHubUser: () => Promise<void>;
  onConnectUserAgent: (
    provider: AgentProvider,
    input: PutAgentProviderConnectionInput,
  ) => Promise<void>;
  onDisconnectUserAgent: (
    connection: RedactedProviderConnection,
  ) => Promise<void>;
  onInviteMember: (input: CreateInvitationInput) => Promise<void>;
  onRevokeInvitation: (invitation: OrganizationInvitation) => Promise<void>;
  onSelectOrganization: (organizationId: string) => void;
  onSyncGitHub: (installation: GitHubInstallation) => Promise<void>;
  providerBusy: boolean;
  providers: ProviderCapability;
  selectedOrganizationId: string;
  userProviderBusy: boolean;
  userProviders: ProviderCapability;
}) {
  const [panel, setPanel] = useState<SettingsPanel>(initialPanel);
  const membership =
    account.organizations.find(({ id }) => id === selectedOrganizationId) ??
    account.organizations[0];

  useEffect(() => {
    setPanel(initialPanel);
  }, [initialPanel]);

  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)] bg-[var(--color-bg-primary)]">
      <nav className="min-h-0 overflow-auto border-r border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] p-3">
        <button
          className="mb-4 flex h-8 items-center gap-2 rounded-md px-2 text-sm text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
          onClick={onBack}
          type="button"
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
          Back to app
        </button>

        <SettingsGroup label="Personal">
          <SettingsNavItem
            active={panel === "profile"}
            icon={User}
            label="Profile"
            onClick={() => setPanel("profile")}
          />
          <SettingsNavItem
            active={panel === "notifications"}
            icon={Bell}
            label="Notifications"
            onClick={() => setPanel("notifications")}
          />
        </SettingsGroup>

        <SettingsGroup count={account.organizations.length} label="Organizations">
          <button
            className="flex h-8 w-full cursor-not-allowed items-center gap-2 rounded-md px-2 text-left text-sm text-[var(--color-text-passive)] opacity-50"
            disabled
            title="Organization creation is not implemented by this control plane"
            type="button"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add organization
          </button>
          {account.organizations.map((organization) => (
            <button
              aria-current={
                organization.id === selectedOrganizationId ? "true" : undefined
              }
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${
                organization.id === selectedOrganizationId
                  ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
              }`}
              key={organization.id}
              onClick={() => {
                onSelectOrganization(organization.id);
                setPanel("organization");
              }}
              type="button"
            >
              <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {organization.displayName}
              </span>
              <span className="font-mono text-[9px] uppercase text-[var(--color-text-passive)]">
                {organization.role}
              </span>
            </button>
          ))}
        </SettingsGroup>

        <SettingsGroup label="Admin">
          <SettingsNavItem
            active={panel === "providers"}
            icon={KeyRound}
            label="Provider connections"
            onClick={() => setPanel("providers")}
          />
        </SettingsGroup>
      </nav>

      <div className="min-h-0 overflow-auto p-8">
        <div className="mx-auto max-w-3xl space-y-8">
          <section>
            <h2 className="text-base font-medium text-[var(--foreground)]">
              {settingsTitle(panel)}
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--color-text-passive)]">
              {settingsDescription(panel)}
            </p>
          </section>

          {panel === "profile" ? (
            <SettingsSection
              description="Your hosted identity is managed by WorkOS."
              title="Profile"
            >
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <label className="text-xs text-[var(--muted-foreground)]">
                  Name
                  <input
                    className={`${fieldClass} mt-1.5`}
                    disabled
                    value={account.user.displayName}
                    readOnly
                  />
                </label>
                <button
                  className={`${buttonClass} self-end`}
                  disabled
                  title="Profile updates are not implemented"
                  type="button"
                >
                  Save profile
                </button>
                <p className="text-xs leading-5 text-[var(--color-text-passive)] sm:col-span-2">
                  Email is used for login and invitations:{" "}
                  <span className="text-[var(--muted-foreground)]">
                    {account.user.email}
                  </span>
                </p>
              </div>
            </SettingsSection>
          ) : null}

          {panel === "profile" ? (
            <CodingAgentSettings
              busy={userProviderBusy}
              description="Connect a credential once and it works in every organization you belong to — no need to reconnect it per org."
              onConnect={onConnectUserAgent}
              onDisconnect={onDisconnectUserAgent}
              providers={userProviders}
              title="Your personal coding agents"
            />
          ) : null}

          {panel === "notifications" ? (
            <SettingsSection
              description="Organization invitation APIs are not available yet."
              title="Invitations for you"
            >
              <EmptyCapability message="No notification feed is exposed by the current control plane." />
            </SettingsSection>
          ) : null}

          {panel === "organization" ? (
            <SettingsSection
              description={`Projects and sessions are scoped to this organization. Your role is ${membership?.role ?? "unknown"}.`}
              title={membership?.displayName ?? "Organization"}
            >
              <div className="space-y-6">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <label className="text-xs text-[var(--muted-foreground)]">
                    Organization name
                    <input
                      className={`${fieldClass} mt-1.5`}
                      disabled
                      readOnly
                      value={membership?.displayName ?? ""}
                    />
                  </label>
                  <button
                    className={`${buttonClass} self-end`}
                    disabled
                    title="Organization updates are not implemented"
                    type="button"
                  >
                    Save
                  </button>
                </div>
                <MembersSettings
                  busy={membersBusy}
                  members={members}
                  onInvite={onInviteMember}
                  onRevoke={onRevokeInvitation}
                  viewerRole={membership?.role}
                />
                <UnavailableRow
                  description="Credential inheritance is not exposed by this control plane."
                  title="Coding agent credential source"
                />
              </div>
            </SettingsSection>
          ) : null}

          {panel === "providers" ? (
            <div className="space-y-8">
              <GitHubSettings
                busy={busy}
                github={github}
                githubUser={githubUser}
                onConnect={onConnectGitHub}
                onDisconnect={onDisconnectGitHub}
                onDisconnectUser={onDisconnectGitHubUser}
                onSync={onSyncGitHub}
              />
              <CodingAgentSettings
                busy={providerBusy}
                onConnect={onConnectAgent}
                onDisconnect={onDisconnectAgent}
                providers={providers}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CodingAgentSettings({
  busy,
  description = "Credentials are validated, encrypted, and never returned by the API.",
  onConnect,
  onDisconnect,
  providers,
  title = "Coding agents",
}: {
  busy: boolean;
  description?: string;
  onConnect: (
    provider: AgentProvider,
    input: PutAgentProviderConnectionInput,
  ) => Promise<void>;
  onDisconnect: (connection: RedactedProviderConnection) => Promise<void>;
  providers: ProviderCapability;
  title?: string;
}) {
  const [editing, setEditing] = useState<AgentProvider | null>(null);
  const [credentialType, setCredentialType] =
    useState<PutAgentProviderConnectionInput["credentialType"]>("api_key");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const agents: Array<{ id: AgentProvider; label: string }> = [
    { id: "claude-code", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    { id: "cursor", label: "Cursor" },
  ];

  return (
    <SettingsSection description={description} title={title}>
      {providers.status === "loading" ? (
        <p className="text-sm text-[var(--color-text-passive)]">
          Loading coding-agent connections…
        </p>
      ) : providers.status === "error" ? (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
          {providers.message ?? "Provider connections could not be loaded."}
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border-strong)] border-y border-[var(--color-border-strong)]">
          {agents.map((agent) => {
            const connection = providers.connections.find(
              ({ provider }) => provider === agent.id,
            );
            const isEditing = editing === agent.id;
            return (
              <div className="py-3" key={agent.id}>
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-[var(--foreground)]">
                      {agent.label}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-text-passive)]">
                      {connection
                        ? `Connected · ${connection.validationState}`
                        : "Not connected"}
                    </p>
                  </div>
                  {connection ? (
                    <button
                      className={buttonClass}
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Disconnect ${agent.label} credentials from this organization?`,
                          )
                        ) {
                          void onDisconnect(connection);
                        }
                      }}
                      type="button"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      className={buttonClass}
                      disabled={busy}
                      onClick={() => {
                        setEditing(isEditing ? null : agent.id);
                        setCredentialType("api_key");
                        setSecret("");
                        setError("");
                      }}
                      type="button"
                    >
                      Connect
                    </button>
                  )}
                </div>
                {isEditing && !connection ? (
                  <form
                    className="mt-3 grid gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] p-3 sm:grid-cols-[180px_minmax(0,1fr)_auto]"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      setError("");
                      try {
                        await onConnect(agent.id, {
                          credentialType,
                          secret,
                        });
                        setEditing(null);
                        setSecret("");
                      } catch (cause) {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "The credential could not be connected.",
                        );
                      }
                    }}
                  >
                    <label className="text-xs text-[var(--muted-foreground)]">
                      Credential type
                      <select
                        className={`${fieldClass} mt-1.5`}
                        onChange={(event) =>
                          setCredentialType(
                            event.target
                              .value as PutAgentProviderConnectionInput["credentialType"],
                          )
                        }
                        value={credentialType}
                      >
                        <option value="api_key">API key</option>
                        {agent.id === "claude-code" ? (
                          <option value="oauth_token">OAuth token</option>
                        ) : null}
                        {agent.id === "codex" ? (
                          <option value="access_token">Access token</option>
                        ) : null}
                      </select>
                    </label>
                    <label className="text-xs text-[var(--muted-foreground)]">
                      Secret
                      <input
                        autoComplete="off"
                        className={`${fieldClass} mt-1.5 font-mono`}
                        onChange={(event) => setSecret(event.target.value)}
                        placeholder="Paste credential"
                        required
                        type="password"
                        value={secret}
                      />
                    </label>
                    <button
                      className={`${primaryButtonClass} self-end`}
                      disabled={busy || !secret.trim()}
                      type="submit"
                    >
                      {busy ? "Validating…" : "Save"}
                    </button>
                    {error ? (
                      <p
                        className="text-xs text-[var(--color-error)] sm:col-span-3"
                        role="alert"
                      >
                        {error}
                      </p>
                    ) : null}
                  </form>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}

function GitHubSettings({
  busy,
  github,
  githubUser,
  onConnect,
  onDisconnect,
  onDisconnectUser,
  onSync,
}: {
  busy: boolean;
  github: GitHubCapability;
  githubUser: GitHubUserCapability;
  onConnect: () => Promise<void>;
  onDisconnect: (installation: GitHubInstallation) => Promise<void>;
  onDisconnectUser: () => Promise<void>;
  onSync: (installation: GitHubInstallation) => Promise<void>;
}) {
  const hostedAuthRequired =
    github.status === "auth-required" || githubUser.status === "auth-required";
  const connected =
    githubUser.connection.connected &&
    github.status === "available" &&
    github.installations.length > 0;
  return (
    <SettingsSection
      description="Controls which repositories this organization can use for Cloud projects."
      title="GitHub"
    >
      <div className="mb-5 flex items-start gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-3">
        <GitFork className="mt-0.5 size-4 text-[var(--color-text-passive)]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--foreground)]">
            {connected
              ? `Connected as ${githubUser.connection.login}`
              : "Connect GitHub"}
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-passive)]">
            {connected
              ? `${github.installations.length} App installation${github.installations.length === 1 ? "" : "s"} available to this organization.`
              : "One connection flow authorizes your GitHub account, then installs the AO GitHub App for repository access."}
          </p>
        </div>
        {hostedAuthRequired ? (
          <a className={primaryButtonClass} href="/github-sign-in">
            Continue
          </a>
        ) : connected ? (
          <button
            className={buttonClass}
            disabled={busy}
            onClick={() => {
              if (window.confirm("Revoke AO's GitHub user authorization?")) {
                void onDisconnectUser();
              }
            }}
            type="button"
          >
            Disconnect
          </button>
        ) : (
          <button
            className={primaryButtonClass}
            disabled={
              busy ||
              githubUser.status === "loading" ||
              github.status === "loading"
            }
            onClick={() => void onConnect()}
            type="button"
          >
            Connect GitHub
          </button>
        )}
      </div>
      {github.status === "loading" ? (
        <p className="text-sm text-[var(--color-text-passive)]">
          Loading GitHub connection…
        </p>
      ) : github.status === "auth-required" ? null : github.status ===
        "unavailable" ? (
        <UnavailableRow
          description={
            github.message ??
            "GitHub is intentionally disabled outside the production control plane."
          }
          title="GitHub is disabled"
        />
      ) : github.status === "error" ? (
        <div className="rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
          {github.message ?? "GitHub connection could not be loaded."}
        </div>
      ) : (
        <div className="space-y-4">
          {github.installations.length === 0 ? (
            <div className="flex items-start gap-3">
              <GitFork className="mt-0.5 size-4 text-[var(--color-text-passive)]" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-[var(--foreground)]">
                  No GitHub installation
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-passive)]">
                  Install the AO GitHub App to grant repository access.
                </p>
              </div>
            </div>
          ) : (
            github.installations.map((installation) => (
              <div
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-3"
                key={installation.id}
              >
                <GitFork className="size-4 text-[var(--muted-foreground)]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[var(--foreground)]">
                    {installation.accountLogin}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-passive)]">
                    {installation.status} · {installation.syncStatus} ·{" "}
                    {installation.repositorySelection} repositories
                  </p>
                </div>
                <button
                  aria-label={`Sync ${installation.accountLogin}`}
                  className={iconButtonClass}
                  disabled={busy}
                  onClick={() => void onSync(installation)}
                  title="Sync repositories"
                  type="button"
                >
                  <RefreshCw className="size-3.5" />
                </button>
                <button
                  aria-label={`Disconnect ${installation.accountLogin}`}
                  className={iconButtonClass}
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Disconnect GitHub account ${installation.accountLogin}? Cloud projects will no longer be able to use its repository grants.`,
                      )
                    ) {
                      void onDisconnect(installation);
                    }
                  }}
                  title="Disconnect GitHub"
                  type="button"
                >
                  <Unplug className="size-3.5" />
                </button>
              </div>
            ))
          )}
          {github.installations.length > 0 ? (
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => void onConnect()}
              type="button"
            >
              Add GitHub installation
            </button>
          ) : null}
          <p className="text-xs text-[var(--color-text-passive)]">
            {github.repositories.filter(({ access }) => access === "active").length}{" "}
            active repositories available for project import.
          </p>
        </div>
      )}
    </SettingsSection>
  );
}

function MembersSettings({
  busy,
  members,
  onInvite,
  onRevoke,
  viewerRole,
}: {
  busy: boolean;
  members: MembersCapability;
  onInvite: (input: CreateInvitationInput) => Promise<void>;
  onRevoke: (invitation: OrganizationInvitation) => Promise<void>;
  viewerRole: string | undefined;
}) {
  const canManage = viewerRole === "owner" || viewerRole === "admin";
  const [email, setEmail] = useState("");
  const [role, setRole] =
    useState<CreateInvitationInput["role"]>("member");
  const [error, setError] = useState("");

  return (
    <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-3">
      <div className="flex items-start gap-3">
        <Users className="mt-0.5 size-4 text-[var(--color-text-passive)]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-[var(--foreground)]">
            Members and invitations
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-passive)]">
            {canManage
              ? "Invite teammates and manage who has access to this organization."
              : "Only owners and admins can invite or remove members."}
          </p>
        </div>
      </div>

      {members.status === "loading" ? (
        <p className="mt-3 text-sm text-[var(--color-text-passive)]">
          Loading members…
        </p>
      ) : members.status === "error" ? (
        <div className="mt-3 rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
          {members.message ?? "Members could not be loaded."}
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          <div className="divide-y divide-[var(--color-border-strong)] rounded-md border border-[var(--color-border-strong)]">
            {members.members.map((member) => (
              <div
                className="flex items-center gap-3 px-3 py-2.5"
                key={member.userId}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[var(--foreground)]">
                    {member.displayName || member.email}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-[var(--color-text-passive)]">
                    {member.email}
                  </p>
                </div>
                <span className="font-mono text-[9px] uppercase tracking-wide text-[var(--color-text-passive)]">
                  {member.role}
                </span>
              </div>
            ))}
          </div>

          {members.invitations.filter(
            (invitation) => invitation.status === "pending",
          ).length > 0 ? (
            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-passive)]">
                Pending invitations
              </p>
              <div className="divide-y divide-[var(--color-border-strong)] rounded-md border border-[var(--color-border-strong)]">
                {members.invitations
                  .filter((invitation) => invitation.status === "pending")
                  .map((invitation) => (
                    <div
                      className="flex items-center gap-3 px-3 py-2.5"
                      key={invitation.id}
                    >
                      <Mail className="size-3.5 shrink-0 text-[var(--color-text-passive)]" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-[var(--foreground)]">
                          {invitation.email}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--color-text-passive)]">
                          Invited as {invitation.role} · expires{" "}
                          {new Date(invitation.expiresAt).toLocaleDateString()}
                        </p>
                      </div>
                      {canManage ? (
                        <button
                          aria-label={`Revoke invitation to ${invitation.email}`}
                          className={iconButtonClass}
                          disabled={busy}
                          onClick={() => void onRevoke(invitation)}
                          title="Revoke invitation"
                          type="button"
                        >
                          <X className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  ))}
              </div>
            </div>
          ) : null}

          {canManage ? (
            <form
              className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px_auto]"
              onSubmit={async (event) => {
                event.preventDefault();
                setError("");
                try {
                  await onInvite({ email: email.trim(), role });
                  setEmail("");
                  setRole("member");
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "The invitation could not be created.",
                  );
                }
              }}
            >
              <label className="text-xs text-[var(--muted-foreground)]">
                Invite by email
                <input
                  className={`${fieldClass} mt-1.5`}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="teammate@example.com"
                  required
                  type="email"
                  value={email}
                />
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                Role
                <select
                  className={`${fieldClass} mt-1.5`}
                  onChange={(event) =>
                    setRole(
                      event.target.value as CreateInvitationInput["role"],
                    )
                  }
                  value={role}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <button
                className={`${primaryButtonClass} self-end`}
                disabled={busy || !email.trim()}
                type="submit"
              >
                {busy ? "Inviting…" : "Invite"}
              </button>
              {error ? (
                <p
                  className="text-xs text-[var(--color-error)] sm:col-span-3"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
            </form>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SettingsGroup({
  children,
  count,
  label,
}: {
  children: ReactNode;
  count?: number;
  label: string;
}) {
  return (
    <div className="mb-5">
      <div className="flex items-center px-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-passive)]">
          {label}
        </p>
        {count !== undefined ? (
          <span className="ml-auto font-mono text-[10px] text-[var(--color-text-passive)]">
            {count}
          </span>
        ) : null}
      </div>
      <div className="mt-1 space-y-0.5">{children}</div>
    </div>
  );
}

function SettingsNavItem({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${
        active
          ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]"
          : "text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
      }`}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

function SettingsSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section>
      <div className="border-b border-[var(--color-border-strong)] pb-3">
        <h3 className="text-sm font-medium text-[var(--foreground)]">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-passive)]">
          {description}
        </p>
      </div>
      <div className="pt-4">{children}</div>
    </section>
  );
}

function UnavailableRow({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-3">
      <Settings className="mt-0.5 size-4 text-[var(--color-text-passive)]" />
      <div>
        <p className="text-sm text-[var(--muted-foreground)]">{title}</p>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-passive)]">
          {description}
        </p>
      </div>
    </div>
  );
}

function EmptyCapability({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-4 text-sm text-[var(--color-text-passive)]">
      {message}
    </p>
  );
}

function settingsTitle(panel: SettingsPanel) {
  switch (panel) {
    case "profile":
      return "Profile";
    case "notifications":
      return "Notifications";
    case "providers":
      return "Provider connections";
    default:
      return "Organization";
  }
}

function settingsDescription(panel: SettingsPanel) {
  switch (panel) {
    case "profile":
      return "Manage how your account appears in AO Cloud.";
    case "notifications":
      return "Review invitations and account activity.";
    case "providers":
      return "Manage GitHub and coding-agent connections.";
    default:
      return "Review organization membership and workspace configuration.";
  }
}

const fieldClass =
  "h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--foreground)] outline-none disabled:cursor-not-allowed disabled:opacity-55";
const buttonClass =
  "inline-flex h-9 items-center justify-center rounded-md border border-[var(--color-border-strong)] px-3 text-xs text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)] disabled:cursor-not-allowed disabled:opacity-45";
const primaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-md bg-[var(--color-accent-strong)] px-3 text-xs font-semibold text-[var(--color-accent-foreground)] disabled:opacity-45";
const iconButtonClass =
  "grid size-8 place-items-center rounded-md text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] disabled:opacity-45";
