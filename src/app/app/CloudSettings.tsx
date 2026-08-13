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
  Unplug,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

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
import type {
  GitHubCapability,
  GitHubUserCapability,
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
  open,
  onBack,
  onConnectGitHub,
  onConnectAgent,
  onDisconnectAgent,
  onDisconnectGitHub,
  onDisconnectGitHubUser,
  onSelectOrganization,
  onSyncGitHub,
  providerBusy,
  providers,
  selectedOrganizationId,
}: {
  account: CurrentAccount;
  busy: boolean;
  github: GitHubCapability;
  githubUser: GitHubUserCapability;
  initialPanel: "organization" | "providers";
  open: boolean;
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
  onSelectOrganization: (organizationId: string) => void;
  onSyncGitHub: (installation: GitHubInstallation) => Promise<void>;
  providerBusy: boolean;
  providers: ProviderCapability;
  selectedOrganizationId: string;
}) {
  const [panel, setPanel] = useState<SettingsPanel>(initialPanel);
  const membership =
    account.organizations.find(({ id }) => id === selectedOrganizationId) ??
    account.organizations[0];

  useEffect(() => {
    setPanel(initialPanel);
  }, [initialPanel]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onBack()}>
      <DialogContent
        className={`${settingsDialogContentClass} h-(--size-settings-dialog-height) w-(--size-settings-dialog-wide) max-h-none origin-center overflow-hidden p-0`}
        showCloseButton={false}
        style={{
          height: "min(680px, calc(100dvh - 32px))",
          width: "min(920px, calc(100vw - 32px))",
        }}
      >
        <div className="flex h-full min-h-0">
          <aside className="flex w-48 shrink-0 flex-col border-r border-(--color-border-settings-dialog-header) bg-card">
            <p className="px-3 pb-1 pt-3 text-2xs font-semibold tracking-wider text-muted-foreground/60">
              Settings
            </p>
            <nav aria-label="Settings sections" className="flex flex-col gap-0.5 p-2 pt-0">
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
              {account.organizations.map((organization) => (
                <SettingsNavItem
                  active={
                    panel === "organization" &&
                    organization.id === selectedOrganizationId
                  }
                  icon={Building2}
                  key={organization.id}
                  label={organization.displayName}
                  onClick={() => {
                    onSelectOrganization(organization.id);
                    setPanel("organization");
                  }}
                />
              ))}
              <SettingsNavItem
                active={panel === "providers"}
                icon={KeyRound}
                label="Provider connections"
                onClick={() => setPanel("providers")}
              />
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col bg-card">
            <DialogHeader className={`${settingsDialogHeaderClass} flex h-auto shrink-0 flex-row items-center justify-between border-b-0`}>
              <DialogTitle className="text-2xl font-bold text-foreground">
              {settingsTitle(panel)}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {settingsDescription(panel)}
              </DialogDescription>
              <DialogClose
                aria-label="Close settings"
                className="settings-close-button grid size-8 place-items-center rounded-md border border-transparent text-[var(--color-text-passive)] transition-colors hover:border-(--color-border-settings-input) hover:bg-[var(--color-bg-settings-input)] hover:text-[var(--foreground)]"
              >
                <X className="size-4" aria-hidden="true" />
              </DialogClose>
            </DialogHeader>
        <div className={`${settingsDialogBodyClass} flex-1`}>
        <div className="w-full space-y-8">

          {panel === "profile" ? (
            <SettingsSection
              title="Profile"
              titleHidden
              grouped
            >
              <SettingsRow icon={User} label="Display name">
                <span className="settings-row-value">{account.user.displayName}</span>
              </SettingsRow>
              <SettingsRow icon={User} label="Email">
                <span className="settings-row-value">{account.user.email}</span>
              </SettingsRow>
            </SettingsSection>
          ) : null}

          {panel === "notifications" ? (
            <SettingsSection
              title="Invitations for you"
              titleHidden
              grouped
            >
              <SettingsRow icon={Bell} label="Activity">
                <span className="settings-row-value">Not available</span>
              </SettingsRow>
            </SettingsSection>
          ) : null}

          {panel === "organization" ? (
            <SettingsSection
              title={membership?.displayName ?? "Organization"}
              titleHidden
              grouped
            >
              <SettingsRow icon={Building2} label="Organization name">
                <span className="settings-row-value">{membership?.displayName ?? "—"}</span>
              </SettingsRow>
              <SettingsRow icon={Building2} label="Role">
                <span className="settings-row-value">{membership?.role ?? "Unknown"}</span>
              </SettingsRow>
              <SettingsRow icon={KeyRound} label="Credentials">
                <span className="settings-row-value">Organization managed</span>
              </SettingsRow>
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
}: {
  busy: boolean;
  onConnect: (
    provider: AgentProvider,
    input: PutAgentProviderConnectionInput,
  ) => Promise<void>;
  onDisconnect: (connection: RedactedProviderConnection) => Promise<void>;
  providers: ProviderCapability;
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
    <SettingsSection grouped title="Coding agents">
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
              <SettingsRow icon={KeyRound} label={agent.label}>
                <div className="flex items-center gap-3">
                  <span className="settings-row-value">
                    {connection ? `Connected · ${connection.validationState}` : "Not connected"}
                  </span>
                  <button
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => {
                      if (connection) {
                        if (window.confirm(`Disconnect ${agent.label} credentials from this organization?`)) {
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
    <SettingsSection grouped title="GitHub">
      <SettingsRow icon={GitFork} label="GitHub account">
        <div className="flex items-center gap-3">
          <span className="settings-row-value">
            {connected ? githubUser.connection.login : "Not connected"}
          </span>
          {hostedAuthRequired ? (
            <a className={primaryButtonClass} href="/github-sign-in">Continue</a>
          ) : connected ? (
            <button className={buttonClass} disabled={busy} onClick={() => {
              if (window.confirm("Revoke AO's GitHub user authorization?")) void onDisconnectUser();
            }} type="button">Disconnect</button>
          ) : (
            <button className={primaryButtonClass} disabled={busy || githubUser.status === "loading" || github.status === "loading"} onClick={() => void onConnect()} type="button">Connect GitHub</button>
          )}
        </div>
      </SettingsRow>
      {github.status === "loading" ? <p className="px-3 py-4 text-sm text-[var(--color-text-passive)]">Loading GitHub connection…</p> : null}
      {github.status === "unavailable" ? <p className="px-3 py-4 text-sm text-[var(--color-text-passive)]">{github.message ?? "GitHub is disabled for this environment."}</p> : null}
      {github.status === "error" ? <p className="px-3 py-4 text-sm text-[var(--color-error)]">{github.message ?? "GitHub connection could not be loaded."}</p> : null}
      {github.status === "available" && github.installations.length === 0 ? (
        <SettingsRow icon={GitFork} label="App installation"><span className="settings-row-value">No GitHub installation</span></SettingsRow>
      ) : null}
      {github.status === "available" ? github.installations.map((installation) => (
        <SettingsRow icon={GitFork} key={installation.id} label={installation.accountLogin}>
          <div className="flex items-center gap-2">
            <span className="settings-row-value">{installation.repositorySelection} repositories</span>
            <button aria-label={`Sync ${installation.accountLogin}`} className={iconButtonClass} disabled={busy} onClick={() => void onSync(installation)} title="Sync repositories" type="button"><RefreshCw className="size-3.5" /></button>
            <button aria-label={`Disconnect ${installation.accountLogin}`} className={iconButtonClass} disabled={busy} onClick={() => {
              if (window.confirm(`Disconnect GitHub account ${installation.accountLogin}? Cloud projects will no longer be able to use its repository grants.`)) void onDisconnect(installation);
            }} title="Disconnect GitHub" type="button"><Unplug className="size-3.5" /></button>
          </div>
        </SettingsRow>
      )) : null}
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
      className={`flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium transition-[background-color,color,transform] duration-fast ease-out active:scale-[0.98] focus:outline-none focus-visible:outline-none focus-visible:ring-0 ${
        active
          ? "bg-[var(--color-interactive-active)] text-foreground"
          : "text-muted-foreground hover:bg-[var(--color-interactive-hover)] hover:text-foreground"
      }`}
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
  icon: Icon,
  label,
}: {
  children: ReactNode;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="settings-row-bar">
      <div className="flex shrink-0 items-center gap-(--size-settings-row-icon-gap)">
        <Icon className="size-icon-lg shrink-0 text-settings-muted" aria-hidden="true" />
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
