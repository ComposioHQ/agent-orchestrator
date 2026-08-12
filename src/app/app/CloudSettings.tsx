"use client";

import type {
  CurrentAccount,
  GitHubInstallation,
} from "@aoagents/cloud-client";
import {
  Bell,
  Building2,
  ChevronLeft,
  GitFork,
  KeyRound,
  Plus,
  RefreshCw,
  Settings,
  Unplug,
  User,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import type { GitHubCapability } from "./cloud-ui-types";

type SettingsPanel = "profile" | "notifications" | "organization" | "providers";

export function CloudSettings({
  account,
  busy,
  github,
  onBack,
  onDisconnectGitHub,
  onSelectOrganization,
  onStartGitHub,
  onSyncGitHub,
  selectedOrganizationId,
}: {
  account: CurrentAccount;
  busy: boolean;
  github: GitHubCapability;
  onBack: () => void;
  onDisconnectGitHub: (installation: GitHubInstallation) => Promise<void>;
  onSelectOrganization: (organizationId: string) => void;
  onStartGitHub: () => Promise<void>;
  onSyncGitHub: (installation: GitHubInstallation) => Promise<void>;
  selectedOrganizationId: string;
}) {
  const [panel, setPanel] = useState<SettingsPanel>("organization");
  const membership =
    account.organizations.find(({ id }) => id === selectedOrganizationId) ??
    account.organizations[0];

  useEffect(() => {
    setPanel("organization");
  }, [selectedOrganizationId]);

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
                <UnavailableRow
                  description="Member lists, roles, and invitations require organization-management routes."
                  title="Members and invitations"
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
                onDisconnect={onDisconnectGitHub}
                onStart={onStartGitHub}
                onSync={onSyncGitHub}
              />
              <SettingsSection
                description="Coding-agent credentials will be encrypted and delivered only during worker bootstrap."
                title="Coding agents"
              >
                <div className="divide-y divide-[var(--color-border-strong)] border-y border-[var(--color-border-strong)]">
                  {["Claude Code", "Codex", "Cursor"].map((agent) => (
                    <div
                      className="flex items-center gap-3 py-3"
                      key={agent}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-[var(--foreground)]">{agent}</p>
                        <p className="mt-0.5 text-xs text-[var(--color-text-passive)]">
                          Credential management unavailable
                        </p>
                      </div>
                      <button
                        className={buttonClass}
                        disabled
                        title="Agent credential routes are not implemented"
                        type="button"
                      >
                        Connect
                      </button>
                    </div>
                  ))}
                </div>
              </SettingsSection>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GitHubSettings({
  busy,
  github,
  onDisconnect,
  onStart,
  onSync,
}: {
  busy: boolean;
  github: GitHubCapability;
  onDisconnect: (installation: GitHubInstallation) => Promise<void>;
  onStart: () => Promise<void>;
  onSync: (installation: GitHubInstallation) => Promise<void>;
}) {
  return (
    <SettingsSection
      description="Controls which repositories this organization can use for Cloud projects."
      title="GitHub"
    >
      {github.status === "loading" ? (
        <p className="text-sm text-[var(--color-text-passive)]">
          Loading GitHub connection…
        </p>
      ) : github.status === "unavailable" ? (
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
              <button
                className={primaryButtonClass}
                disabled={busy}
                onClick={() => void onStart()}
                type="button"
              >
                Connect GitHub
              </button>
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
              onClick={() => void onStart()}
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
