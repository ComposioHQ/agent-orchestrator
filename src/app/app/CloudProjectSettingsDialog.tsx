"use client";

import type { Project, UpdateProjectInput } from "@aoagents/cloud-client";
import { Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

export function CloudProjectSettingsDialog({
  busy,
  onClose,
  onDelete,
  onSave,
  project,
}: {
  busy: boolean;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onSave: (input: UpdateProjectInput) => Promise<void>;
  project: Project;
}) {
  const [displayName, setDisplayName] = useState(project.displayName);
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch);
  const [error, setError] = useState("");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  return (
    <div
      aria-label={`Project settings for ${project.displayName}`}
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      role="dialog"
    >
      <form
        className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] shadow-2xl"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await onSave({
              displayName: displayName.trim(),
              defaultBranch: defaultBranch.trim(),
            });
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Project settings could not be saved.",
            );
          }
        }}
      >
        <header className="flex h-12 items-center border-b border-[var(--color-border-strong)] px-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
            Project settings
          </h2>
          <button
            aria-label="Close project settings"
            className="ml-auto grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-5 p-5">
          <label className="block text-xs text-[var(--muted-foreground)]">
            Project name
            <input
              autoFocus
              className={fieldClass}
              disabled={busy}
              maxLength={120}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              value={displayName}
            />
          </label>
          <label className="block text-xs text-[var(--muted-foreground)]">
            Default branch
            <input
              className={fieldClass}
              disabled={busy}
              maxLength={255}
              onChange={(event) => setDefaultBranch(event.target.value)}
              required
              value={defaultBranch}
            />
          </label>
          <label className="block text-xs text-[var(--muted-foreground)]">
            Repository
            <input
              className={`${fieldClass} font-mono opacity-65`}
              disabled
              readOnly
              value={project.repositoryUrl}
            />
            <span className="mt-1.5 block leading-5 text-[var(--color-text-passive)]">
              Repository identity is immutable because checkout grants and
              existing sessions are bound to it.
            </span>
          </label>
          <section className="rounded-lg border border-[var(--color-error)]/25 bg-[var(--color-error)]/5 p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm text-[var(--foreground)]">
                  Delete project
                </h3>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-passive)]">
                  Stops every agent and removes the project from your workspace.
                  Durable audit history is retained.
                </p>
              </div>
              <button
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-[var(--color-error)]/40 px-3 text-xs text-[var(--color-error)] hover:bg-[var(--color-error)]/10 disabled:opacity-45"
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Delete ${project.displayName}? Every agent in this project will be stopped.`,
                    )
                  ) {
                    return;
                  }
                  setError("");
                  try {
                    await onDelete();
                  } catch (cause) {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "The project could not be deleted.",
                    );
                  }
                }}
                type="button"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                Delete project
              </button>
            </div>
          </section>
          {error ? (
            <p
              className="rounded-md border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-xs text-[var(--color-error)]"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--color-border-strong)] px-5 py-4">
          <button
            className={secondaryButtonClass}
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className={primaryButtonClass}
            disabled={busy || !displayName.trim() || !defaultBranch.trim()}
            type="submit"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </footer>
      </form>
    </div>
  );
}

const fieldClass =
  "mt-1.5 h-10 w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--foreground)] outline-none focus:border-[var(--color-accent-strong)] disabled:cursor-not-allowed disabled:opacity-55";
const secondaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-md border border-[var(--color-border-strong)] px-3 text-xs text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)] disabled:opacity-45";
const primaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-md bg-[var(--color-accent-strong)] px-3 text-xs font-semibold text-[var(--color-accent-foreground)] disabled:opacity-45";
