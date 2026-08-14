"use client";

import type {
  CurrentAccount,
  GitHubInstallation,
  PutAgentProviderConnectionInput,
  RedactedProviderConnection,
} from "@aoagents/cloud-client";
import {
  Bell,
  Building2,
  GitFork,
  KeyRound,
  RefreshCw,
  Settings2,
  Unplug,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  type ThemePreference,
  type ThemeStyle,
  readStoredThemePreference,
  readStoredThemeStyle,
  saveThemePreference,
  saveThemeStyle,
} from "@/lib/theme";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  settingsDialogBodyClass,
  settingsDialogContentClass,
  settingsDialogHeaderClass,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { SettingsOptionMenu } from "@/components/settings/SettingsOptionMenu";
import type {
  GitHubCapability,
  GitHubUserCapability,
  MembersCapability,
  ProviderCapability,
} from "./cloud-ui-types";
import type { CreateInvitationInput, OrganizationInvitation } from "./share-types";
import { WorkspaceAvatar } from "./CloudWorkspaceSwitcher";

type SettingsPanel = "general" | "profile" | "notifications" | "workspaces" | "providers";
type AgentProvider = "claude-code" | "codex" | "cursor";

export function CloudSettings({
  account,
  busy,
  github,
  githubUser,
  initialPanel,
  incomingInvitations,
  members,
  membersBusy,
  open,
  onBack,
  onAcceptInvitation,
  onDeclineInvitation,
  onConnectGitHub,
  onConnectGitHubOrganization,
  onDisconnectGitHub,
  onDisconnectGitHubUser,
  onConnectUserAgent,
  onDisconnectUserAgent,
  onInviteMember,
  onUpdateMemberRole,
  onRevokeInvitation,
  onSelectOrganization,
  onSyncGitHub,
  onSyncGitHubUser,
  selectedOrganizationId,
  userProviderBusy,
  userProviders,
}: {
  account: CurrentAccount;
  busy: boolean;
  github: GitHubCapability;
  githubUser: GitHubUserCapability;
  initialPanel: SettingsPanel;
  incomingInvitations: OrganizationInvitation[];
  members: MembersCapability;
  membersBusy: boolean;
  open: boolean;
  onBack: () => void;
  onAcceptInvitation: (invitation: OrganizationInvitation) => Promise<void>;
  onDeclineInvitation: (invitation: OrganizationInvitation) => Promise<void>;
  onConnectGitHub: () => Promise<void>;
  onConnectGitHubOrganization: () => Promise<void>;
  onDisconnectGitHub: (installation: GitHubInstallation) => Promise<void>;
  onDisconnectGitHubUser: () => Promise<void>;
  onConnectUserAgent: (
    provider: AgentProvider,
    input: PutAgentProviderConnectionInput,
  ) => Promise<void>;
  onDisconnectUserAgent: (connection: RedactedProviderConnection) => Promise<void>;
  onInviteMember: (input: CreateInvitationInput) => Promise<void>;
  onUpdateMemberRole: (userId: string, role: "owner" | "admin" | "member") => Promise<void>;
  onRevokeInvitation: (invitation: OrganizationInvitation) => Promise<void>;
  onSelectOrganization: (organizationId: string) => void;
  onSyncGitHub: (installation: GitHubInstallation) => Promise<void>;
  onSyncGitHubUser: () => Promise<void>;
  selectedOrganizationId: string;
  userProviderBusy: boolean;
  userProviders: ProviderCapability;
}) {
  const [panel, setPanel] = useState<SettingsPanel>(initialPanel);
  const selectedOrganization = account.organizations.find(({ id }) => id === selectedOrganizationId);
  const canManageMembers = selectedOrganization?.role === "owner" || selectedOrganization?.role === "admin";

  const lastPanelRef = useRef<SettingsPanel>(panel);
  if (open) lastPanelRef.current = panel;
  const displayPanel = open ? panel : lastPanelRef.current;

  useEffect(() => {
    if (open) setPanel(initialPanel);
  }, [initialPanel, open]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onBack()}>
      <DialogContent
        className={cn(
          settingsDialogContentClass,
          "h-(--size-settings-dialog-height) w-(--size-settings-dialog-wide) max-h-none origin-center overflow-hidden p-0",
        )}
        style={{
          height: "min(680px, calc(100svh - 32px))",
          width: "min(920px, calc(100vw - 32px))",
          maxWidth: "calc(100vw - 32px)",
        }}
        showCloseButton={false}
      >
        <div className="flex h-full min-h-0">
          <aside className="flex w-48 shrink-0 flex-col border-r border-(--color-border-settings-dialog-header) bg-card">
            <p className="px-3 pb-1 pt-3 text-2xs font-semibold tracking-wider text-muted-foreground/60">
              Settings
            </p>
            <nav aria-label="Settings sections" className="flex flex-col gap-0.5 p-2 pt-0">
              <SettingsNavItem
                active={displayPanel === "general"}
                icon={Settings2}
                label="General"
                onClick={() => setPanel("general")}
              />
              <SettingsNavItem
                active={displayPanel === "profile"}
                icon={User}
                label="Profile"
                onClick={() => setPanel("profile")}
              />
              <SettingsNavItem
                active={displayPanel === "notifications"}
                icon={Bell}
                label="Notifications"
                onClick={() => setPanel("notifications")}
              />
              <SettingsNavItem
                active={displayPanel === "workspaces"}
                icon={Building2}
                label="Workspaces"
                onClick={() => setPanel("workspaces")}
              />
              <SettingsNavItem
                active={displayPanel === "providers"}
                icon={KeyRound}
                label="Providers"
                onClick={() => setPanel("providers")}
              />
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col bg-card">
            <DialogHeader className={cn(settingsDialogHeaderClass, "flex h-auto shrink-0 flex-row items-center justify-between border-b-0")}>
              <DialogTitle className="text-2xl font-bold text-foreground">
                {settingsTitle(displayPanel)}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {settingsDescription(displayPanel)}
              </DialogDescription>
              <DialogClose
                aria-label="Close settings"
                className="settings-close-button border border-transparent transition-colors hover:border-(--color-border-settings-input) hover:bg-[var(--color-bg-settings-input)]"
              >
                <X className="size-4" aria-hidden="true" />
              </DialogClose>
            </DialogHeader>
            <div className={cn(settingsDialogBodyClass, "flex-1")}>
              <div className="w-full space-y-8">

                {displayPanel === "general" ? (
                  <GeneralSettingsPanel />
                ) : null}

                {displayPanel === "profile" ? (
                  <>
                    <SettingsSection title="Profile" titleHidden grouped>
                      <SettingsRow label="Display name">
                        <span className="settings-row-value">{account.user.displayName}</span>
                      </SettingsRow>
                      <SettingsRow label="Email">
                        <span className="settings-row-value">{account.user.email}</span>
                      </SettingsRow>
                    </SettingsSection>
                  </>
                ) : null}

                {displayPanel === "notifications" ? (
                  <SettingsSection title="Invitations for you" titleHidden grouped>
                    {incomingInvitations.length === 0 ? (
                      <SettingsRow label="Activity"><span className="settings-row-value">No pending invitations</span></SettingsRow>
                    ) : incomingInvitations.map((invitation) => (
                      <SettingsRow key={invitation.id} label={invitation.invitedByName || invitation.invitedByEmail || invitation.email}>
                        <div className="flex items-center gap-2">
                          <span className="settings-row-value">{invitation.role}</span>
                          <button className={buttonClass} onClick={() => void onDeclineInvitation(invitation)} type="button">Decline</button>
                          <button className={primaryButtonClass} onClick={() => void onAcceptInvitation(invitation)} type="button">Accept</button>
                        </div>
                      </SettingsRow>
                    ))}
                  </SettingsSection>
                ) : null}

                {displayPanel === "workspaces" ? (
                  <div className="space-y-8">
                    <WorkspacesPanel account={account} onSelectOrganization={onSelectOrganization} />
                    <MembersSettings
                      busy={membersBusy}
                      canManage={canManageMembers}
                      members={members}
                      onInvite={onInviteMember}
                      onRevoke={onRevokeInvitation}
                      onUpdateRole={onUpdateMemberRole}
                      currentUserId={account.user.id}
                    />
                  </div>
                ) : null}

                {displayPanel === "providers" ? (
                  <div className="space-y-8">
                    <GitHubSettings
                      busy={busy}
                      github={github}
                      githubUser={githubUser}
                      onConnect={onConnectGitHub}
                      onConnectOrganization={onConnectGitHubOrganization}
                      onDisconnect={onDisconnectGitHub}
                      onDisconnectUser={onDisconnectGitHubUser}
                      onSync={onSyncGitHub}
                      onSyncUser={onSyncGitHubUser}
                    />
                    <CodingAgentSettings
                      busy={userProviderBusy}
                      onConnect={onConnectUserAgent}
                      onDisconnect={onDisconnectUserAgent}
                      providers={userProviders}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CodingAgentSettings({
  busy,
  onConnect,
  onDisconnect,
  providers,
  title = "Coding agents",
}: {
  busy: boolean;
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
    <SettingsSection grouped title={title}>
      {providers.status === "loading" ? (
        <p className="px-3 py-4 text-sm text-[var(--color-text-passive)]">
          Loading coding-agent connections…
        </p>
      ) : providers.status === "error" ? (
        <div className="px-3 py-3 text-sm text-[var(--color-error)]">
          {providers.message ?? "Provider connections could not be loaded."}
        </div>
      ) : (
        agents.map((agent) => {
          const connection = providers.connections.find(
            ({ provider }) => provider === agent.id,
          );
          const isEditing = editing === agent.id;
          return (
            <div key={agent.id}>
              <SettingsRow label={agent.label}>
                <div className="flex items-center gap-3">
                  <span className="settings-row-value">
                    {connection ? `Connected · ${connection.validationState}` : ""}
                  </span>
                  <button
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => {
                      if (connection) {
                        if (window.confirm(`Disconnect ${agent.label} credentials from this workspace?`)) {
                          void onDisconnect(connection);
                        }
                        return;
                      }
                      setEditing(isEditing ? null : agent.id);
                      setCredentialType("api_key");
                      setSecret("");
                      setError("");
                    }}
                    type="button"
                  >
                    {connection ? "Disconnect" : "Connect"}
                  </button>
                </div>
              </SettingsRow>
              {isEditing && !connection ? (
                <form
                  className="grid gap-3 border-t border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] p-3 sm:grid-cols-[180px_minmax(0,1fr)_auto]"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    setError("");
                    try {
                      await onConnect(agent.id, { credentialType, secret });
                      setEditing(null);
                      setSecret("");
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : "The credential could not be connected.");
                    }
                  }}
                >
                  <label className="text-xs text-[var(--muted-foreground)]">
                    Credential type
                    <select className={`${fieldClass} mt-1.5`} onChange={(event) => setCredentialType(event.target.value as PutAgentProviderConnectionInput["credentialType"])} value={credentialType}>
                      <option value="api_key">API key</option>
                      {agent.id === "claude-code" ? <option value="oauth_token">OAuth token</option> : null}
                      {agent.id === "codex" ? <option value="access_token">Access token</option> : null}
                    </select>
                  </label>
                  <label className="text-xs text-[var(--muted-foreground)]">
                    Secret
                    <input autoComplete="off" className={`${fieldClass} mt-1.5 font-mono`} onChange={(event) => setSecret(event.target.value)} placeholder="Paste credential" required type="password" value={secret} />
                  </label>
                  <button className={`${primaryButtonClass} self-end`} disabled={busy || !secret.trim()} type="submit">
                    {busy ? "Validating…" : "Save"}
                  </button>
                  {error ? <p className="text-xs text-[var(--color-error)] sm:col-span-3" role="alert">{error}</p> : null}
                </form>
              ) : null}
            </div>
          );
        })
      )}
    </SettingsSection>
  );
}

function GitHubSettings({
  busy,
  github,
  githubUser,
  onConnect,
  onConnectOrganization,
  onDisconnect,
  onDisconnectUser,
  onSync,
  onSyncUser,
}: {
  busy: boolean;
  github: GitHubCapability;
  githubUser: GitHubUserCapability;
  onConnect: () => Promise<void>;
  onConnectOrganization: () => Promise<void>;
  onDisconnect: (installation: GitHubInstallation) => Promise<void>;
  onDisconnectUser: () => Promise<void>;
  onSync: (installation: GitHubInstallation) => Promise<void>;
  onSyncUser: () => Promise<void>;
}) {
  const hostedAuthRequired =
    github.status === "auth-required" || githubUser.status === "auth-required";
  const accountConnected = githubUser.connection.connected;
  const orgInstallations =
    github.status === "available"
      ? github.installations.filter(
          (installation) => installation.status !== "removed",
        )
      : [];
  const hasOrgAccess = orgInstallations.length > 0;
  const creationOwners = githubUser.connection.installations.filter(
    (installation) => installation.canCreateRepository,
  );
  return (
    <SettingsSection grouped title="GitHub">
      <SettingsRow label="GitHub account">
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <span className="settings-row-value">
            {accountConnected
              ? githubUser.connection.login
              : "GitHub account not connected"}
          </span>
          {hostedAuthRequired ? (
            <a className={primaryButtonClass} href="/github-sign-in">Continue</a>
          ) : accountConnected ? (
            <div className="flex items-center gap-1">
              <button className={buttonClass} disabled={busy} onClick={() => void onSyncUser()} type="button">
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Sync
              </button>
              <button className={buttonClass} disabled={busy} onClick={() => {
                if (window.confirm("Disconnect your GitHub account from AO? Existing organization grants remain, but personal actions will require reconnecting.")) void onDisconnectUser();
              }} type="button">Disconnect</button>
            </div>
          ) : (
            <button className={primaryButtonClass} disabled={busy || githubUser.status === "loading" || github.status === "loading"} onClick={() => void onConnect()} type="button">
              {hasOrgAccess ? "Connect account" : "Connect GitHub"}
            </button>
          )}
        </div>
      </SettingsRow>
      {github.status === "loading" ? <p className="px-3 py-4 text-sm text-[var(--color-text-passive)]">Loading GitHub connection…</p> : null}
      {github.status === "unavailable" ? <p className="px-3 py-4 text-sm text-[var(--color-text-passive)]">{github.message ?? "GitHub is disabled for this environment."}</p> : null}
      {github.status === "error" ? <p className="px-3 py-4 text-sm text-[var(--color-error)]">{github.message ?? "GitHub connection could not be loaded."}</p> : null}
      {accountConnected && creationOwners.length > 0 ? (
        <SettingsRow label="Repository creation">
          <span className="settings-row-value">
            {creationOwners.map((installation) => installation.accountLogin).join(", ")}
          </span>
        </SettingsRow>
      ) : null}
      {hasOrgAccess ? (
        <>
          <SettingsRow label="Organization repository access">
            <button
              aria-label="Manage organization repository access"
              className={buttonClass}
              disabled={busy}
              onClick={() => void onConnectOrganization()}
              type="button"
            >
              Manage
            </button>
          </SettingsRow>
          {orgInstallations.map((installation) => (
            <SettingsRow key={installation.id} label={installation.accountLogin}>
              <div className="flex items-center gap-2">
                <span className="settings-row-value">
                  {installation.accountType} · {installation.repositorySelection === "all" ? "all repositories" : "selected repositories"}
                </span>
                <button aria-label={`Sync ${installation.accountLogin}`} className={iconButtonClass} disabled={busy} onClick={() => void onSync(installation)} title="Sync repositories" type="button"><RefreshCw className="size-3.5" /></button>
                <button aria-label={`Disconnect ${installation.accountLogin}`} className={iconButtonClass} disabled={busy} onClick={() => {
                  if (window.confirm(`Disconnect GitHub account ${installation.accountLogin}? Cloud projects will no longer be able to use its repository grants.`)) void onDisconnect(installation);
                }} title="Disconnect GitHub" type="button"><Unplug className="size-3.5" /></button>
              </div>
            </SettingsRow>
          ))}
        </>
      ) : accountConnected && github.status === "available" ? (
        <SettingsRow label="Organization repository access">
          <div className="flex items-center gap-3">
            <span className="settings-row-value">Not connected</span>
            <button className={primaryButtonClass} disabled={busy} onClick={() => void onConnectOrganization()} type="button">
              Connect organization
            </button>
          </div>
        </SettingsRow>
      ) : null}
    </SettingsSection>
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
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium transition-[background-color,color,transform] duration-fast ease-out active:scale-press focus:outline-none focus-visible:outline-none focus-visible:ring-0",
        active
          ? "bg-interactive-active text-foreground"
          : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}

function SettingsSection({
  children,
  grouped = false,
  title,
  titleHidden = false,
}: {
  children: ReactNode;
  grouped?: boolean;
  title: string;
  titleHidden?: boolean;
}) {
  return (
    <section className="flex w-full flex-col items-stretch gap-(--size-settings-section-inner-gap)">
      {!titleHidden ? (
        <h2 className="px-3 text-xs font-medium leading-4 text-settings-muted">
          {title}
        </h2>
      ) : null}
      <div
        className={
          grouped
            ? "settings-grouped-rows flex w-full flex-col"
            : "flex w-full flex-col gap-1.5"
        }
      >
        {children}
      </div>
    </section>
  );
}

function SettingsRow({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="settings-row-bar">
      <div className="flex shrink-0 items-center gap-(--size-settings-row-icon-gap)">
        <span className="whitespace-nowrap text-sm leading-5 text-settings-label">
          {label}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end">{children}</div>
    </div>
  );
}

function settingsTitle(panel: SettingsPanel) {
  switch (panel) {
    case "general":
      return "General";
    case "profile":
      return "Profile";
    case "notifications":
      return "Notifications";
    case "providers":
      return "Providers";
    default:
      return "Workspaces";
  }
}

function settingsDescription(panel: SettingsPanel) {
  switch (panel) {
    case "general":
      return "Appearance and display preferences.";
    case "profile":
      return "Manage how your account appears in AO Cloud.";
    case "notifications":
      return "Review invitations and account activity.";
    case "providers":
      return "Manage GitHub and coding-agent connections.";
    default:
      return "Manage your workspaces.";
  }
}

const COLOR_THEMES: Array<{ value: ThemeStyle; label: string }> = [
  { value: "orchestrate", label: "Orchestrate" },
  { value: "github", label: "GitHub" },
  { value: "catppuccin", label: "Catppuccin" },
  { value: "dracula", label: "Dracula" },
  { value: "tokyo-night", label: "Tokyo Night" },
  { value: "rose-pine", label: "Rosé Pine" },
  { value: "nord", label: "Nord" },
  { value: "gruvbox", label: "Gruvbox" },
  { value: "solarized", label: "Solarized" },
];

const APPEARANCE_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function GeneralSettingsPanel() {
  const [themeStyle, setThemeStyle] = useState<ThemeStyle>(readStoredThemeStyle);
  const [themePref, setThemePref] = useState<ThemePreference>(readStoredThemePreference);

  return (
    <SettingsSection title="Appearance" grouped>
      <SettingsRow label="Color theme">
        <SettingsOptionMenu
          aria-label="Color theme"
          value={themeStyle}
          options={COLOR_THEMES}
          onChange={(v) => {
            setThemeStyle(v);
            saveThemeStyle(v);
          }}
        />
      </SettingsRow>
      <SettingsRow label="Appearance">
        <SettingsOptionMenu
          aria-label="Appearance"
          value={themePref}
          options={APPEARANCE_OPTIONS}
          onChange={(v) => {
            setThemePref(v);
            saveThemePreference(v);
          }}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function WorkspacesPanel({
  account,
  onSelectOrganization,
}: {
  account: CurrentAccount;
  onSelectOrganization: (id: string) => void;
}) {
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)]">
            <th className="pb-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Name</th>
            <th className="pb-2 text-left text-xs font-medium text-[var(--muted-foreground)]">Role</th>
            <th className="pb-2 text-right text-xs font-medium text-[var(--muted-foreground)]" />
          </tr>
        </thead>
        <tbody>
          {account.organizations.map((org) => (
            <tr key={org.id} className="group/org border-b border-[var(--border)]/40">
              <td className="py-3 text-[var(--foreground)]">
                <div className="flex items-center gap-2.5">
                  <WorkspaceAvatar name={org.displayName} id={org.id} size={20} />
                  {org.displayName}
                </div>
              </td>
              <td className="py-3 text-[var(--muted-foreground)]">{org.role}</td>
              <td className="py-3 text-right">
                <button
                  type="button"
                  className="cursor-pointer text-xs text-[var(--muted-foreground)] opacity-0 transition-opacity group-hover/org:opacity-100 hover:text-[var(--foreground)]"
                  onClick={() => onSelectOrganization(org.id)}
                >
                  Switch
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MembersSettings({
  busy,
  canManage,
  currentUserId,
  members,
  onInvite,
  onRevoke,
  onUpdateRole,
}: {
  busy: boolean;
  canManage: boolean;
  currentUserId: string;
  members: MembersCapability;
  onInvite: (input: CreateInvitationInput) => Promise<void>;
  onRevoke: (invitation: OrganizationInvitation) => Promise<void>;
  onUpdateRole: (userId: string, role: "owner" | "admin" | "member") => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CreateInvitationInput["role"]>("member");
  const [error, setError] = useState("");

  return (
    <SettingsSection grouped title="Members">
      {members.status === "loading" ? (
        <p className="px-3 py-4 text-sm text-[var(--color-text-passive)]">Loading members…</p>
      ) : members.status === "error" ? (
        <p className="px-3 py-4 text-sm text-[var(--color-error)]">{members.message ?? "Members could not be loaded."}</p>
      ) : (
        <>
          {members.members.map((member) => (
            <SettingsRow key={member.userId} label={member.displayName || member.email}>
              <select
                aria-label={`Role for ${member.email}`}
                className={`${fieldClass} h-8 w-28`}
                disabled={busy || !canManage || member.userId === currentUserId}
                onChange={(event) => {
                  setError("");
                  void onUpdateRole(
                    member.userId,
                    event.target.value as "owner" | "admin" | "member",
                  ).catch((cause) => setError(cause instanceof Error ? cause.message : "The role could not be updated."));
                }}
                value={member.role}
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
              </select>
            </SettingsRow>
          ))}
          {members.invitations.map((invitation) => (
            <SettingsRow key={invitation.id} label={invitation.email}>
              <div className="flex items-center gap-3">
                <span className="settings-row-value">{invitation.status === "pending" ? "Invited" : invitation.status}</span>
                {invitation.status === "pending" ? (
                  <button className={buttonClass} disabled={busy || !canManage} onClick={() => void onRevoke(invitation)} type="button">
                    Revoke
                  </button>
                ) : null}
              </div>
            </SettingsRow>
          ))}
          <form
            className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] p-3"
            onSubmit={async (event) => {
              event.preventDefault();
              setError("");
              try {
                await onInvite({ email, role });
                setEmail("");
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "The invitation could not be sent.");
              }
            }}
          >
            <input className={`${fieldClass} h-8 min-w-40 flex-1`} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required type="email" value={email} />
            <select className={`${fieldClass} h-8 w-28`} onChange={(event) => setRole(event.target.value as CreateInvitationInput["role"])} value={role}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button className={`${primaryButtonClass} h-8`} disabled={busy || !canManage || !email.trim()} type="submit">
              Invite
            </button>
            {error ? <p className="w-full text-xs text-[var(--color-error)]" role="alert">{error}</p> : null}
          </form>
        </>
      )}
    </SettingsSection>
  );
}

const fieldClass =
  "h-10 w-full rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--foreground)] outline-none disabled:cursor-not-allowed disabled:opacity-55";
const buttonClass =
  "inline-flex h-[38px] cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-bg-settings-input)] px-3 text-sm text-[var(--foreground)] transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45";
const primaryButtonClass =
  "inline-flex h-[38px] cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-transparent bg-[var(--color-accent-strong)] px-3 text-sm font-semibold text-[var(--color-accent-foreground)] transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45";
const iconButtonClass =
  "grid size-8 cursor-pointer place-items-center rounded-2xl text-[var(--color-text-passive)] transition-opacity duration-150 hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] disabled:opacity-45";
