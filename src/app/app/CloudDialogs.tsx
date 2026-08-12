"use client";

import type {
  CreateProjectInput,
  CreateSessionInput,
  GitHubRepository,
  Project,
} from "@aoagents/cloud-client";
import { AgentAvatar } from "@aoagents/product-ui";
import {
  Bot,
  FolderGit2,
  GitFork,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { useState } from "react";

import type { GitHubCapability } from "./cloud-ui-types";

export function NewProjectDialog({
  github,
  onClose,
  onCreate,
  onCreateFromGitHub,
  onOpenProviderSettings,
}: {
  github: GitHubCapability;
  onClose: () => void;
  onCreate: (input: CreateProjectInput) => Promise<void>;
  onCreateFromGitHub: (repository: GitHubRepository) => Promise<void>;
  onOpenProviderSettings: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<
    "choose" | "project" | "github" | "manual"
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
            : "Create project"
      }
    >
      {mode === "choose" ? (
        <div className="p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <CreationOption
              description="Use a GitHub repository with the project workflow."
              icon={FolderGit2}
              label="Create a Project"
              onClick={() => setMode("project")}
            />
            <CreationOption
              description="Start an independent agent runtime."
              disabled
              icon={Bot}
              label="Create a Standalone Agent"
              status="Execution unavailable"
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
              description="Start an empty Cloud project, optionally backed by a new GitHub repository."
              disabled
              icon={FolderGit2}
              label="Start from scratch"
              status="Backend unavailable"
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
            <div className="flex items-center gap-2">
              <button
                className={secondaryButtonClass}
                onClick={() => setMode("manual")}
                type="button"
              >
                Use repository URL
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
      ) : (
        <form
          className="space-y-4 p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            const form = new FormData(event.currentTarget);
            try {
              await onCreate({
                displayName: String(form.get("displayName") || "").trim(),
                repositoryUrl: String(form.get("repositoryUrl") || "").trim(),
                defaultBranch:
                  String(form.get("defaultBranch") || "").trim() || "main",
                config: {},
              });
              onClose();
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not create project.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field autoFocus label="Project name" name="displayName" required />
          <Field
            label="GitHub repository URL"
            name="repositoryUrl"
            placeholder="https://github.com/acme/project"
            type="url"
            pattern="https://github\.com/.+/.+"
            required
          />
          <Field
            defaultValue="main"
            label="Default branch"
            name="defaultBranch"
            required
          />
          <DialogFooter
            busy={busy}
            error={error}
            onBack={() => setMode("project")}
            onCancel={onClose}
            submitLabel="Create project"
          />
        </form>
      )}
    </Dialog>
  );
}

export function NewSessionDialog({
  onClose,
  onCreate,
  projects,
  selectedProjectId,
}: {
  onClose: () => void;
  onCreate: (input: CreateSessionInput) => Promise<void>;
  projects: Project[];
  selectedProjectId: string | null;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [harness, setHarness] = useState("claude-code");
  const project =
    projects.find(({ id }) => id === selectedProjectId) ?? projects[0];

  return (
    <Dialog onClose={onClose} title="New cloud worker">
      <form
        className="space-y-4 p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!project) return;
          setBusy(true);
          setError("");
          const form = new FormData(event.currentTarget);
          try {
            await onCreate({
              projectId: project.id,
              kind: "worker",
              harness,
              displayName: String(form.get("displayName") || "").trim(),
              prompt: String(form.get("prompt") || "").trim(),
              mode: "standard",
              deniedCommands: [],
            });
            onClose();
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : "Could not create session.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {project ? (
          <p className="text-xs text-[var(--color-text-passive)]">
            Project{" "}
            <span className="text-[var(--muted-foreground)]">
              {project.displayName}
            </span>
          </p>
        ) : null}
        <Field
          autoFocus
          label="Worker name"
          maxLength={40}
          name="displayName"
          placeholder="Worker name"
          required
        />
        <label className="block">
          <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
            Coding agent
          </span>
          <div className="relative">
            <AgentAvatar
              className="pointer-events-none absolute left-3 top-1/2 z-10 size-[18px] -translate-y-1/2"
              provider={harness}
            />
            <select
              className={`${controlClass} pl-10`}
              name="harness"
              onChange={(event) => setHarness(event.target.value)}
              value={harness}
            >
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="cursor">Cursor</option>
            </select>
          </div>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
            Initial prompt
          </span>
          <textarea
            className={`${controlClass} min-h-32 resize-y py-3`}
            name="prompt"
            placeholder="What should this worker do?"
            required
          />
        </label>
        <div className="text-xs leading-5 text-[var(--color-text-passive)]">
          This saves the worker request. Runtime execution is not available yet.
        </div>
        <DialogFooter
          busy={busy}
          error={error}
          onCancel={onClose}
          submitDisabled={!project}
          submitLabel="Create worker"
        />
      </form>
    </Dialog>
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

function Field({
  label,
  ...props
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
        {label}
      </span>
      <input {...props} className={controlClass} />
    </label>
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
