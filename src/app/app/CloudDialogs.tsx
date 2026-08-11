"use client";

import type {
  CreateProjectInput,
  CreateSessionInput,
  Project,
} from "@aoagents/cloud-client";
import { X } from "lucide-react";
import type {
  FormEvent,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { useState } from "react";

export function NewProjectDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: CreateProjectInput) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog onClose={onClose} title="New project">
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
              cause instanceof Error ? cause.message : "Could not create project.",
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
          onCancel={onClose}
          submitLabel="Create project"
        />
      </form>
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

  return (
    <Dialog onClose={onClose} title="New session">
      <form
        className="space-y-4 p-5"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          const form = new FormData(event.currentTarget);
          try {
            await onCreate({
              projectId: String(form.get("projectId") || ""),
              kind: String(form.get("kind") || "worker") as
                | "worker"
                | "orchestrator",
              harness: String(form.get("harness") || "claude-code"),
              displayName: String(form.get("displayName") || "").trim(),
              prompt: String(form.get("prompt") || "").trim(),
              mode: String(form.get("mode") || "standard") as
                | "read-only"
                | "standard"
                | "trusted",
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
        <Field autoFocus label="Session name" name="displayName" required />
        <label className="block">
          <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
            Project
          </span>
          <select
            className={controlClass}
            defaultValue={selectedProjectId ?? projects[0]?.id}
            name="projectId"
            required
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.displayName}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="Type"
            name="kind"
            options={[
              ["worker", "Worker"],
              ["orchestrator", "Orchestrator"],
            ]}
          />
          <SelectField
            label="Harness"
            name="harness"
            options={[
              ["claude-code", "Claude Code"],
              ["codex", "Codex"],
              ["cursor", "Cursor"],
            ]}
          />
        </div>
        <SelectField
          label="Security mode"
          name="mode"
          options={[
            ["read-only", "Read only"],
            ["standard", "Standard"],
            ["trusted", "Trusted"],
          ]}
        />
        <label className="block">
          <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
            Initial prompt
          </span>
          <textarea
            className={`${controlClass} min-h-24 resize-y py-2`}
            name="prompt"
            required
          />
        </label>
        <div className="rounded-md border border-[#facc15]/20 bg-[#facc15]/5 px-3 py-2 text-[11px] leading-5 text-[var(--muted-foreground)]">
          This creates the durable session and policy record. Worker and
          orchestrator execution is intentionally disabled.
        </div>
        <DialogFooter
          busy={busy}
          error={error}
          onCancel={onClose}
          submitLabel="Create session"
        />
      </form>
    </Dialog>
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

function SelectField({
  label,
  name,
  options,
}: {
  label: string;
  name: string;
  options: Array<[string, string]>;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
        {label}
      </span>
      <select className={controlClass} name={name}>
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function DialogFooter({
  busy,
  error,
  onCancel,
  submitLabel,
}: {
  busy: boolean;
  error: string;
  onCancel: () => void;
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
        <button
          className="h-9 rounded-md px-3 text-xs text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)]"
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className="h-9 rounded-md bg-[var(--color-accent-strong)] px-3 text-xs font-semibold text-[var(--color-accent-foreground)] disabled:opacity-50"
          disabled={busy}
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
