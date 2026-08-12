"use client";

import type { Project, Session } from "@aoagents/cloud-client";
import { Check, Eye, PencilLine, ShieldCheck, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

type ShareRole = "viewer" | "editor";
type ShareScope = "anyone" | "restricted";
type SharePolicy = "read-only" | "standard" | "trusted";

export function CloudShareDialog({
  onClose,
  project,
  sessions,
}: {
  onClose: () => void;
  project: Project;
  sessions: Session[];
}) {
  const [role, setRole] = useState<ShareRole>("viewer");
  const [scope, setScope] = useState<ShareScope>("anyone");
  const [policy, setPolicy] = useState<SharePolicy>("standard");
  const [commandGuard, setCommandGuard] = useState(true);
  const [sessionRoles, setSessionRoles] = useState<Record<string, ShareRole | "none">>(
    {},
  );

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
            <ShareSection label="Permission">
              <div
                aria-label="Permission"
                className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                role="radiogroup"
              >
                <RoleOption
                  description="View sessions and durable conversation history."
                  icon={Eye}
                  label="Viewer"
                  onSelect={() => {
                    setRole("viewer");
                    setSessionRoles((current) =>
                      Object.fromEntries(
                        Object.entries(current).map(([sessionId, value]) => [
                          sessionId,
                          value === "editor" ? "viewer" : value,
                        ]),
                      ),
                    );
                  }}
                  selected={role === "viewer"}
                />
                <RoleOption
                  description="Interact with existing sessions when execution is available."
                  icon={PencilLine}
                  label="Editor"
                  onSelect={() => setRole("editor")}
                  selected={role === "editor"}
                />
              </div>
            </ShareSection>

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
                      setCommandGuard(option.value !== "trusted");
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

            <ShareSection label="Worker access">
              {sessions.length > 0 ? (
                <div className="divide-y divide-[var(--color-border-strong)] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)]">
                  {sessions.map((session) => (
                    <div
                      className="flex items-center gap-3 px-3 py-2"
                      key={session.id}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-[var(--foreground)]">
                          {session.displayName}
                        </p>
                        <p className="truncate text-xs text-[var(--color-text-passive)]">
                          {session.harness}
                        </p>
                      </div>
                      <select
                        aria-label={`Access for ${session.displayName}`}
                        className="h-8 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] px-2 text-xs text-[var(--muted-foreground)] outline-none focus:border-[#4d8dff]"
                        onChange={(event) =>
                          setSessionRoles((current) => ({
                            ...current,
                            [session.id]: event.target.value as
                              | ShareRole
                              | "none",
                          }))
                        }
                        value={sessionRoles[session.id] ?? role}
                      >
                        <option value="none">No access</option>
                        <option value="viewer">View</option>
                        <option disabled={role === "viewer"} value="editor">
                          Edit
                        </option>
                      </select>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-4 text-sm text-[var(--color-text-passive)]">
                  This project has no workers to scope individually.
                </p>
              )}
            </ShareSection>

            <label className="flex items-start gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-3">
              <input
                checked={commandGuard}
                className="mt-1"
                onChange={(event) => setCommandGuard(event.target.checked)}
                type="checkbox"
              />
              <span>
                <span className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                  <ShieldCheck className="size-4" aria-hidden="true" />
                  Enforce command guard
                </span>
                <span className="mt-1 block text-xs leading-5 text-[var(--color-text-passive)]">
                  Shared access may only tighten the project policy.
                </span>
              </span>
            </label>

            <div className="rounded-lg border border-[#facc15]/20 bg-[#facc15]/5 px-3 py-2 text-xs leading-5 text-[var(--muted-foreground)]">
              Sharing routes are not implemented by the current control plane.
              These options mirror the intended policy but cannot create a link yet.
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

function RoleOption({
  description,
  icon: Icon,
  label,
  onSelect,
  selected,
}: {
  description: string;
  icon: typeof Eye;
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-checked={selected}
      className={`relative min-h-[108px] rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4d8dff]/70 ${
        selected
          ? "border-[#4d8dff]/55 bg-[#4d8dff]/10"
          : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.13] hover:bg-white/[0.04]"
      }`}
      onClick={onSelect}
      role="radio"
      type="button"
    >
      <div className="flex items-center gap-2">
        <Icon
          className={`size-4 ${
            selected ? "text-[#75a5ff]" : "text-[var(--color-text-passive)]"
          }`}
        />
        <span className="text-sm font-medium text-[var(--foreground)]">
          {label}
        </span>
        {selected ? (
          <span className="ml-auto grid size-4 place-items-center rounded-full bg-[#4d8dff] text-white">
            <Check className="size-2.5" strokeWidth={3} />
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-xs leading-5 text-[var(--color-text-passive)]">
        {description}
      </p>
    </button>
  );
}

function optionClass(selected: boolean) {
  return `rounded-lg border px-3 py-2 text-left transition-colors ${
    selected
      ? "border-[#4d8dff]/45 bg-[#4d8dff]/10 text-[var(--foreground)]"
      : "border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] text-[var(--muted-foreground)] hover:border-white/20 hover:text-[var(--foreground)]"
  }`;
}
