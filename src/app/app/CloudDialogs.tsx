"use client";

import type { GitHubRepository } from "@aoagents/cloud-client";
import { Bot, FolderGit2, GitFork, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

import type {
  GitHubCapability,
  GitHubUserCapability,
} from "./cloud-ui-types";

export type LocalAgentInput = {
  displayName: string;
  harness: "claude-code" | "codex" | "cursor";
  prompt: string;
};

export type ScratchProjectInput = LocalAgentInput & {
  githubInstallationId?: string;
  private?: boolean;
};

export function NewProjectDialog({
  github,
  githubUser,
  onClose,
  onCreateFromGitHub,
  onCreateScratchProject,
  onCreateStandalone,
  onOpenProviderSettings,
}: {
  github: GitHubCapability;
  githubUser: GitHubUserCapability;
  onClose: () => void;
  onCreateFromGitHub: (repository: GitHubRepository) => Promise<void>;
  onCreateScratchProject: (input: ScratchProjectInput) => Promise<void>;
  onCreateStandalone: (input: LocalAgentInput) => Promise<void>;
  onOpenProviderSettings: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<
    "choose" | "project" | "github" | "scratch" | "standalone"
  >("choose");
  const activeRepositories = github.repositories.filter(
    ({ access, isArchived }) => access === "active" && !isArchived,
  );
  const [repositoryId, setRepositoryId] = useState(
    activeRepositories[0]?.githubRepositoryId ?? "",
  );
  const selectedRepository = activeRepositories.find(
    ({ githubRepositoryId }) => githubRepositoryId === repositoryId,
  ) ?? activeRepositories[0];

  return (
    <Dialog
      onClose={onClose}
      title={
        mode === "choose"
          ? "Create cloud work"
          : mode === "github"
            ? "Add GitHub project"
            : mode === "scratch"
              ? "Create scratch project"
              : mode === "standalone"
                ? "Create standalone agent"
                : "Create project"
      }
    >
      {mode === "choose" ? (
        <div className="p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <CreationOption
              description="Create a project with its own orchestrator."
              icon={FolderGit2}
              label="Create a Project"
              onClick={() => setMode("project")}
            />
            <CreationOption
              description="Start an independent agent runtime."
              icon={Bot}
              label="Create a Standalone Agent"
              onClick={() => setMode("standalone")}
            />
          </div>
          <div className="-mx-4 -mb-4 mt-4 flex justify-end border-t border-[var(--color-border-strong)] px-4 py-3">
            <button
              className={secondaryButtonClass}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : mode === "project" ? (
        <div className="p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <CreationOption
              description={
                github.status === "available"
                  ? "Choose a repository granted to this AO organization."
                  : "GitHub import is available only when the production integration is connected."
              }
              disabled={github.status !== "available"}
              icon={GitFork}
              label="From GitHub"
              onClick={() => setMode("github")}
              status={
                github.status === "loading"
                  ? "Loading"
                  : github.status === "available"
                    ? undefined
                    : "Unavailable here"
              }
            />
            <CreationOption
              description="Start an empty persistent Git workspace with an orchestrator."
              icon={FolderGit2}
              label="Start from scratch"
              onClick={() => setMode("scratch")}
            />
          </div>
          <div className="-mx-4 -mb-4 mt-4 flex items-center justify-between border-t border-[var(--color-border-strong)] px-4 py-3">
            <button
              className={secondaryButtonClass}
              onClick={() => setMode("choose")}
              type="button"
            >
              Back
            </button>
            <button
              className={secondaryButtonClass}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : mode === "github" ? (
        <form
          className="space-y-4 p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!selectedRepository) return;
            setBusy(true);
            setError("");
            try {
              await onCreateFromGitHub(selectedRepository);
              onClose();
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not import the GitHub repository.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {activeRepositories.length > 0 ? (
            <label className="block">
              <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
                GitHub repository
              </span>
              <select
                className={controlClass}
                onChange={(event) => setRepositoryId(event.target.value)}
                value={
                  repositoryId ||
                  activeRepositories[0]?.githubRepositoryId ||
                  ""
                }
              >
                {activeRepositories.map((repository) => (
                  <option
                    key={repository.githubRepositoryId}
                    value={repository.githubRepositoryId}
                  >
                    {repository.fullName}
                    {repository.isPrivate ? " · private" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-4 text-sm text-[var(--color-text-passive)]">
              No active repositories are granted to this organization.
            </div>
          )}
          <button
            className="text-left text-xs text-[#8eb6ff] hover:underline"
            onClick={onOpenProviderSettings}
            type="button"
          >
            Manage GitHub access in Settings
          </button>
          <DialogFooter
            busy={busy}
            error={error}
            onBack={() => setMode("project")}
            onCancel={onClose}
            submitDisabled={!selectedRepository}
            submitLabel="Add project"
          />
        </form>
      ) : mode === "scratch" || mode === "standalone" ? (
        <LocalAgentForm
          busy={busy}
          error={error}
          mode={mode}
          githubUser={githubUser}
          onBack={() => setMode(mode === "scratch" ? "project" : "choose")}
          onCancel={onClose}
          onOpenProviderSettings={onOpenProviderSettings}
          onSubmit={async (input) => {
            setBusy(true);
            setError("");
            try {
              if (mode === "scratch") {
                await onCreateScratchProject(input);
              } else {
                await onCreateStandalone(input);
              }
              onClose();
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not create the agent.",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </Dialog>
  );
}

function LocalAgentForm({
  busy,
  error,
  mode,
  githubUser,
  onBack,
  onCancel,
  onOpenProviderSettings,
  onSubmit,
}: {
  busy: boolean;
  error: string;
  mode: "scratch" | "standalone";
  githubUser: GitHubUserCapability;
  onBack: () => void;
  onCancel: () => void;
  onOpenProviderSettings: () => void;
  onSubmit: (input: ScratchProjectInput) => Promise<void>;
}) {
  const isProject = mode === "scratch";
  const eligibleInstallations = githubUser.connection.installations.filter(
    ({ canCreateRepository }) => canCreateRepository,
  );
  const [useGitHub, setUseGitHub] = useState(false);
  const [installationId, setInstallationId] = useState(
    eligibleInstallations.length === 1
      ? eligibleInstallations[0].githubInstallationId
      : "",
  );
  const [privateRepository, setPrivateRepository] = useState(true);
  const selectedInstallation = eligibleInstallations.find(
    ({ githubInstallationId }) => githubInstallationId === installationId,
  );
  return (
    <form
      className="space-y-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void onSubmit({
          displayName: String(form.get("displayName") ?? "").trim(),
          harness: String(
            form.get("harness") ?? "claude-code",
          ) as LocalAgentInput["harness"],
          prompt: String(form.get("prompt") ?? "").trim(),
          githubInstallationId:
            isProject && useGitHub
              ? selectedInstallation?.githubInstallationId
              : undefined,
          private: isProject && useGitHub ? privateRepository : undefined,
        });
      }}
    >
      <label className="block">
        <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
          {isProject ? "Project name" : "Agent name"}
        </span>
        <input
          autoFocus
          className={controlClass}
          maxLength={isProject ? 60 : 80}
          name="displayName"
          placeholder={isProject ? "My project" : "Standalone agent"}
          required
        />
      </label>
      {isProject ? (
        <label className="flex items-start gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs leading-5 text-[var(--muted-foreground)]">
          <input
            checked={useGitHub}
            className="mt-1"
            disabled={busy}
            onChange={(event) => setUseGitHub(event.target.checked)}
            type="checkbox"
          />
          <span>
            Create a GitHub repository for this project.
            <span className="block text-[var(--color-text-passive)]">
              Leave unchecked for an AO-managed local Git repository.
            </span>
          </span>
        </label>
      ) : null}
      {isProject && useGitHub ? (
        githubUser.status === "available" &&
        githubUser.connection.connected ? (
          <>
            <label className="block">
              <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
                GitHub owner
              </span>
              <select
                className={controlClass}
                disabled={busy || githubUser.connection.installations.length === 0}
                onChange={(event) => setInstallationId(event.target.value)}
                required
                value={installationId}
              >
                <option value="">Choose personal account or organization</option>
                {githubUser.connection.installations.map((installation) => (
                  <option
                    disabled={!installation.canCreateRepository}
                    key={installation.githubInstallationId}
                    value={installation.githubInstallationId}
                  >
                    {installation.accountLogin}
                    {installation.accountType.toLowerCase() === "user"
                      ? " · personal"
                      : " · organization"}
                    {installation.canCreateRepository
                      ? ""
                      : " · configure all repositories"}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-start gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs leading-5 text-[var(--muted-foreground)]">
              <input
                checked={privateRepository}
                className="mt-1"
                disabled={busy}
                onChange={(event) => setPrivateRepository(event.target.checked)}
                type="checkbox"
              />
              <span>Create the GitHub repository as private.</span>
            </label>
          </>
        ) : (
          <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-3 text-xs text-[var(--color-text-passive)]">
            Authorize AO with GitHub to choose an owner and create a repository.{" "}
            <button
              className="text-[#8eb6ff] hover:underline"
              onClick={onOpenProviderSettings}
              type="button"
            >
              Open GitHub settings
            </button>
          </div>
        )
      ) : null}
      <label className="block">
        <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
          Agent harness
        </span>
        <select
          className={controlClass}
          defaultValue="claude-code"
          name="harness"
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="cursor">Cursor Agent</option>
        </select>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
          Initial task <span className="text-white/35">(optional)</span>
        </span>
        <textarea
          className={`${controlClass} min-h-24 resize-y py-2`}
          maxLength={65536}
          name="prompt"
          placeholder={
            isProject
              ? "Describe what the project orchestrator should do."
              : "Give the agent its first task."
          }
        />
      </label>
      <p className="text-xs leading-5 text-[var(--color-text-passive)]">
        {isProject
          ? "AO will initialize a persistent Git workspace and start the project orchestrator."
          : "AO will initialize a persistent Git workspace for this independent agent."}
      </p>
      <DialogFooter
        busy={busy}
        error={error}
        onBack={onBack}
        onCancel={onCancel}
        submitDisabled={isProject && useGitHub && !selectedInstallation}
        submitLabel={isProject ? "Create project" : "Create agent"}
      />
    </form>
  );
}

function CreationOption({
  description,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  status,
}: {
  description: string;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  status?: string;
}) {
  return (
    <button
      className="group flex min-h-44 flex-col rounded-xl border border-white/[0.08] bg-white/[0.025] p-4 text-left transition-colors hover:border-white/[0.16] hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]/70 disabled:cursor-not-allowed disabled:opacity-45"
      disabled={disabled}
      onClick={onClick}
      title={status}
      type="button"
    >
      <span className="flex h-16 w-full items-center justify-center rounded-lg border border-dashed border-white/[0.10] bg-black/15">
        <Icon className="size-6 text-white/55 transition-colors group-hover:text-white" />
      </span>
      <span className="mt-4 text-sm font-medium text-white">
        {label}
      </span>
      <span className="mt-1 text-xs leading-5 text-white/42">
        {description}
      </span>
      {status ? (
        <span className="mt-3 text-[10px] uppercase tracking-[0.08em] text-white/35">
          {status}
        </span>
      ) : null}
    </button>
  );
}

function Dialog({
  children,
  onClose,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  title: string;
}) {
  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4"
      role="dialog"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] shadow-2xl">
        <div className="flex h-12 items-center border-b border-[var(--color-border-strong)] px-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
            {title}
          </h2>
          <button
            aria-label={`Close ${title}`}
            className="ml-auto grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DialogFooter({
  busy,
  error,
  onBack,
  onCancel,
  submitDisabled = false,
  submitLabel,
}: {
  busy: boolean;
  error: string;
  onBack?: () => void;
  onCancel: () => void;
  submitDisabled?: boolean;
  submitLabel: string;
}) {
  return (
    <>
      {error ? (
        <p className="text-xs text-[var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 border-t border-[var(--color-border-strong)] pt-4">
        {onBack ? (
          <button
            className={secondaryButtonClass}
            disabled={busy}
            onClick={onBack}
            type="button"
          >
            Back
          </button>
        ) : null}
        <button
          className={secondaryButtonClass}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className="h-9 rounded-md bg-[var(--color-accent-strong)] px-3 text-xs font-semibold text-[var(--color-accent-foreground)] disabled:opacity-50"
          disabled={busy || submitDisabled}
          type="submit"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </>
  );
}

const controlClass =
  "h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--foreground)] outline-none focus:border-[#4d8dff]";

const secondaryButtonClass =
  "h-9 rounded-md px-3 text-xs text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)] disabled:opacity-50";
