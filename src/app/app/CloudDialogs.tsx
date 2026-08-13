"use client";

import type { GitHubRepository } from "@aoagents/cloud-client";
import { Bot, ChevronDown, FolderGit2, GitFork, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Input } from "@/components/ui/input";
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

type Harness = LocalAgentInput["harness"];

const AGENTS: Array<{ value: Harness; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
];

export function NewProjectDialog({
  connectedProviders = [],
  github,
  githubUser,
  onClose,
  onCreateFromGitHub,
  onCreateScratchProject,
  onCreateStandalone,
  onOpenProviderSettings,
  open = true,
}: {
  connectedProviders?: string[];
  github: GitHubCapability;
  githubUser: GitHubUserCapability;
  onClose: () => void;
  onCreateFromGitHub: (repository: GitHubRepository) => Promise<void>;
  onCreateScratchProject: (input: ScratchProjectInput) => Promise<void>;
  onCreateStandalone: (input: LocalAgentInput) => Promise<void>;
  onOpenProviderSettings: () => void;
  open?: boolean;
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
    <Modal onClose={onClose} open={open} title="Create new">
      {mode === "choose" ? (
        <div className="p-5">
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
        </div>
      ) : mode === "project" ? (
        <div className="p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <CreationOption
              description={
                github.status === "available"
                  ? "Choose a repository granted to this organization."
                  : "Connect GitHub in Settings to import repositories."
              }
              disabled={github.status !== "available"}
              icon={GitFork}
              label="From GitHub"
              onClick={() => setMode("github")}
            />
            <CreationOption
              description="Start an empty workspace with an orchestrator."
              icon={FolderGit2}
              label="Start from scratch"
              onClick={() => setMode("scratch")}
            />
          </div>
          <div className="mt-5 flex justify-end">
            <button className={secondaryBtnClass} onClick={() => setMode("choose")} type="button">
              Back
            </button>
          </div>
        </div>
      ) : mode === "github" ? (
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!selectedRepository) return;
            setBusy(true);
            setError("");
            try {
              await onCreateFromGitHub(selectedRepository);
              onClose();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not import the GitHub repository.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {activeRepositories.length > 0 ? (
            <label className="block">
              <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">GitHub repository</span>
              <select
                className={selectClass}
                onChange={(event) => setRepositoryId(event.target.value)}
                value={repositoryId || activeRepositories[0]?.githubRepositoryId || ""}
              >
                {activeRepositories.map((repository) => (
                  <option key={repository.githubRepositoryId} value={repository.githubRepositoryId}>
                    {repository.fullName}{repository.isPrivate ? " · private" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-4 text-sm text-[var(--color-text-passive)]">
              No active repositories are granted to this organization.
            </div>
          )}
          <button className="text-left text-xs text-[var(--ring)] hover:underline" onClick={onOpenProviderSettings} type="button">
            Manage GitHub access in Settings
          </button>
          <ModalFooter busy={busy} error={error} onBack={() => setMode("project")} onCancel={onClose} submitDisabled={!selectedRepository} submitLabel="Add project" />
        </form>
      ) : mode === "scratch" || mode === "standalone" ? (
        <LocalAgentForm
          busy={busy}
          connectedProviders={connectedProviders}
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
              if (mode === "scratch") await onCreateScratchProject(input);
              else await onCreateStandalone(input);
              onClose();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not create the agent.");
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </Modal>
  );
}

function LocalAgentForm({
  busy, connectedProviders, error, mode, githubUser, onBack, onCancel, onOpenProviderSettings, onSubmit,
}: {
  busy: boolean; connectedProviders: string[]; error: string; mode: "scratch" | "standalone";
  githubUser: GitHubUserCapability; onBack: () => void; onCancel: () => void;
  onOpenProviderSettings: () => void; onSubmit: (input: ScratchProjectInput) => Promise<void>;
}) {
  const isProject = mode === "scratch";
  const eligibleInstallations = githubUser.connection.installations.filter(({ canCreateRepository }) => canCreateRepository);
  const [useGitHub, setUseGitHub] = useState(false);
  const [installationId, setInstallationId] = useState(
    eligibleInstallations.length === 1 ? eligibleInstallations[0].githubInstallationId : "",
  );
  const [privateRepository, setPrivateRepository] = useState(true);
  const [harness, setHarness] = useState<Harness>("claude-code");
  const [harnessOpen, setHarnessOpen] = useState(false);
  const selectedInstallation = eligibleInstallations.find(({ githubInstallationId }) => githubInstallationId === installationId);

  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void onSubmit({
          displayName: String(form.get("displayName") ?? "").trim(),
          harness,
          prompt: String(form.get("prompt") ?? "").trim(),
          githubInstallationId: isProject && useGitHub ? selectedInstallation?.githubInstallationId : undefined,
          private: isProject && useGitHub ? privateRepository : undefined,
        });
      }}
    >
      <label className="block">
        <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
          {isProject ? "Project name" : "Agent name"}
        </span>
        <Input autoFocus maxLength={isProject ? 60 : 80} name="displayName" placeholder={isProject ? "My project" : "Standalone agent"} required />
      </label>

      {isProject ? (
        <label className="flex items-start gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs leading-5 text-[var(--muted-foreground)]">
          <input checked={useGitHub} className="mt-1 cursor-pointer" disabled={busy} onChange={(e) => setUseGitHub(e.target.checked)} type="checkbox" />
          <span>
            Create a GitHub repository for this project.
            <span className="block text-[var(--color-text-passive)]">Leave unchecked for a managed Git repository.</span>
          </span>
        </label>
      ) : null}

      {isProject && useGitHub ? (
        githubUser.status === "available" && githubUser.connection.connected ? (
          <>
            <label className="block">
              <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">GitHub owner</span>
              <select className={selectClass} disabled={busy} onChange={(e) => setInstallationId(e.target.value)} required value={installationId}>
                <option value="">Choose account or organization</option>
                {githubUser.connection.installations.map((inst) => (
                  <option disabled={!inst.canCreateRepository} key={inst.githubInstallationId} value={inst.githubInstallationId}>
                    {inst.accountLogin}{inst.accountType.toLowerCase() === "user" ? " · personal" : " · org"}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-start gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs leading-5 text-[var(--muted-foreground)]">
              <input checked={privateRepository} className="mt-1 cursor-pointer" disabled={busy} onChange={(e) => setPrivateRepository(e.target.checked)} type="checkbox" />
              <span>Create the GitHub repository as private.</span>
            </label>
          </>
        ) : (
          <div className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-3 text-xs text-[var(--color-text-passive)]">
            Authorize with GitHub to choose an owner.{" "}
            <button className="text-[var(--ring)] hover:underline" onClick={onOpenProviderSettings} type="button">Open GitHub settings</button>
          </div>
        )
      ) : null}

      <div className="relative">
        <button
          type="button"
          data-state={harnessOpen ? "open" : "closed"}
          className={`${selectClass} group/harness flex cursor-pointer items-center gap-2 text-left`}
          onClick={() => setHarnessOpen((c) => !c)}
        >
          <img src={`/agents/${harness}.svg`} alt="" className={`size-4 shrink-0 rounded-sm object-contain ${!connectedProviders.includes(harness) ? "opacity-30 grayscale" : ""}`} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{AGENTS.find((a) => a.value === harness)?.label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-[var(--color-text-passive)] transition-transform duration-300 ease-out group-data-[state=open]/harness:rotate-180" aria-hidden="true" />
        </button>
        {harnessOpen ? (
          <>
            <div className="fixed inset-0 z-[99]" onClick={() => setHarnessOpen(false)} />
            <div className="absolute left-0 top-[calc(100%+4px)] z-[100] w-full animate-popover-in rounded-[12px] border border-[var(--border)] bg-[color-mix(in_oklab,var(--popover)_88%,var(--foreground)_12%)] p-1">
              {AGENTS.map((agent) => {
                const unavailable = !connectedProviders.includes(agent.value);
                return (
                  <button
                    key={agent.value}
                    type="button"
                    disabled={unavailable}
                    className={`flex h-9 w-full cursor-default items-center gap-2 rounded-lg px-2.5 text-sm outline-none transition-colors ${
                      unavailable
                        ? "pointer-events-none opacity-40"
                        : agent.value === harness
                          ? "bg-[color-mix(in_oklab,var(--popover)_82%,var(--foreground)_18%)] text-[var(--foreground)]"
                          : "text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)]"
                    }`}
                    onClick={() => { setHarness(agent.value); setHarnessOpen(false); }}
                  >
                    <img src={`/agents/${agent.value}.svg`} alt="" className={`size-4 shrink-0 rounded-sm object-contain ${unavailable ? "grayscale" : ""}`} aria-hidden="true" />
                    {agent.label}
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
        <input type="hidden" name="harness" value={harness} />
      </div>

      <label className="block">
        <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
          Initial task <span className="text-[var(--color-text-passive)]">(optional)</span>
        </span>
        <textarea
          className="min-h-24 w-full resize-y rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--color-text-passive)] focus:border-[var(--ring)]"
          maxLength={65536}
          name="prompt"
          placeholder={isProject ? "Describe what the orchestrator should do." : "Give the agent its first task."}
        />
      </label>

      <ModalFooter
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
}: {
  description: string;
  disabled?: boolean;
  icon: typeof FolderGit2;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      className="group flex cursor-pointer flex-col rounded-xl bg-[var(--color-interactive-active)] p-4 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--card)_90%,var(--foreground)_10%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-45"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Icon className="mb-3 size-5 text-[var(--muted-foreground)] transition-colors group-hover:text-[var(--foreground)]" />
      <span className="text-sm font-medium text-[var(--muted-foreground)] transition-colors group-hover:text-[var(--foreground)]">{label}</span>
      <span className="mt-1 text-xs leading-5 text-[var(--color-text-passive)] transition-colors group-hover:text-[var(--muted-foreground)]">{description}</span>
    </button>
  );
}

function Modal({ children, onClose, open = true, title }: { children: ReactNode; onClose: () => void; open?: boolean; title: string }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[100] w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-visible rounded-lg bg-[var(--card)] text-[var(--foreground)] shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none"
        >
          <div className="flex items-center justify-between px-5 pt-4 pb-0">
            <DialogPrimitive.Title className="text-sm font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            <DialogPrimitive.Close className="grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:text-[var(--foreground)]">
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ModalFooter({
  busy, error, onBack, onCancel, submitDisabled = false, submitLabel,
}: {
  busy: boolean; error: string; onBack?: () => void; onCancel: () => void;
  submitDisabled?: boolean; submitLabel: string;
}) {
  return (
    <>
      {error ? <p className="text-xs text-[var(--color-error)]" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-2 pt-1">
        {onBack ? (
          <button className={secondaryBtnClass} disabled={busy} onClick={onBack} type="button">Back</button>
        ) : null}
        <button
          className="h-9 cursor-pointer rounded-md bg-[var(--color-accent-strong)] px-4 text-sm font-semibold text-[var(--color-accent-foreground)] disabled:opacity-50"
          disabled={busy || submitDisabled}
          type="submit"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </>
  );
}

const selectClass =
  "h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--foreground)] outline-none focus:border-[var(--ring)]";

const secondaryBtnClass =
  "h-9 cursor-pointer rounded-md px-3 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]";
