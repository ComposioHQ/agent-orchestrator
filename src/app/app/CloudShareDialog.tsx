"use client";

import type { Project } from "@aoagents/cloud-client";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

type ShareScope = "anyone" | "restricted";
type SharePolicy = "read-only" | "standard" | "trusted";

export function CloudShareDialog({
  onClose,
  project,
}: {
  onClose: () => void;
  project: Project;
}) {
  const [scope, setScope] = useState<ShareScope>("anyone");
  const [policy, setPolicy] = useState<SharePolicy>("standard");

  return (
    <div
      aria-label={`Share ${project.displayName}`}
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      role="dialog"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] shadow-2xl">
        <div className="flex h-12 items-center border-b border-[var(--color-border-strong)] px-5">
          <h2 className="min-w-0 truncate font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
            Share project · {project.displayName}
          </h2>
          <button
            aria-label="Close sharing"
            className="ml-auto grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
            onClick={onClose}
            type="button"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="max-h-[calc(90vh-48px)] overflow-y-auto">
          <div className="space-y-6 p-5">
            <ShareSection label="Access">
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  {
                    value: "anyone" as const,
                    label: "Anyone with the link",
                    description: "Anyone who receives the link may redeem it.",
                  },
                  {
                    value: "restricted" as const,
                    label: "Restricted recipients",
                    description: "Limit redemption to invited email addresses.",
                  },
                ].map((option) => (
                  <button
                    aria-pressed={scope === option.value}
                    className={optionClass(scope === option.value)}
                    key={option.value}
                    onClick={() => setScope(option.value)}
                    type="button"
                  >
                    <span className="block text-sm">{option.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--color-text-passive)]">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
              {scope === "restricted" ? (
                <label className="mt-3 block text-xs text-[var(--muted-foreground)]">
                  Recipient emails
                  <textarea
                    className="mt-1.5 min-h-20 w-full resize-y rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[#4d8dff]"
                    placeholder="teammate@example.com, reviewer@example.com"
                  />
                </label>
              ) : null}
            </ShareSection>

            <ShareSection label="Sandbox policy">
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  {
                    value: "read-only" as const,
                    label: "Read only",
                    description: "View-only access · command guard on",
                  },
                  {
                    value: "standard" as const,
                    label: "Standard",
                    description: "Selected-worker editing · command guard on",
                  },
                  {
                    value: "trusted" as const,
                    label: "Trusted",
                    description: "Full interaction · command guard off",
                  },
                ].map((option) => (
                  <button
                    aria-pressed={policy === option.value}
                    className={optionClass(policy === option.value)}
                    key={option.value}
                    onClick={() => {
                      setPolicy(option.value);
                    }}
                    type="button"
                  >
                    <span className="block text-sm">{option.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--color-text-passive)]">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
            </ShareSection>

            <div className="rounded-lg border border-[#facc15]/20 bg-[#facc15]/5 px-3 py-2 text-xs leading-5 text-[var(--muted-foreground)]">
              Sharing routes are not implemented by the current control plane.
              These link settings mirror the intended policy but cannot create a
              link yet. Per-person policies and agent access will appear under
              Manage access after recipients join.
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--color-border-strong)] px-5 py-4">
            <button
              className="h-9 rounded-md px-3 text-xs text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)]"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="h-9 cursor-not-allowed rounded-md bg-[var(--color-accent-strong)] px-3 text-xs font-semibold text-[var(--color-accent-foreground)] opacity-45"
              disabled
              title="Project sharing API is not implemented"
              type="button"
            >
              Create link
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShareSection({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">
        {label}
      </h3>
      {children}
    </section>
  );
}

function optionClass(selected: boolean) {
  return `rounded-lg border px-3 py-2 text-left transition-colors ${
    selected
      ? "border-[#4d8dff]/45 bg-[#4d8dff]/10 text-[var(--foreground)]"
      : "border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] text-[var(--muted-foreground)] hover:border-white/20 hover:text-[var(--foreground)]"
  }`;
}
