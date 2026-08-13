"use client";

import type {
  Project,
  ProjectShareLink,
  ProjectShareModeCap,
  SharedProject,
} from "@aoagents/cloud-client";
import { Check, Copy, Trash2, User, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

type ShareScope = "anyone" | "restricted";

const POLICIES: Array<{
  value: ProjectShareModeCap;
  label: string;
  description: string;
}> = [
  {
    value: "read-only",
    label: "Read only",
    description: "View-only access · command guard on",
  },
  {
    value: "standard",
    label: "Standard",
    description: "Selected-worker editing · command guard on",
  },
  {
    value: "trusted",
    label: "Trusted",
    description: "Full interaction · command guard off",
  },
];

export function CloudShareDialog({
  busy,
  grants,
  links,
  onClose,
  onCreate,
  onRevoke,
  onRevokeGrant,
  project,
}: {
  busy: boolean;
  grants: SharedProject[];
  links: ProjectShareLink[];
  onClose: () => void;
  onCreate: (input: {
    accessScope: ShareScope;
    recipients: string[];
    modeCap: ProjectShareModeCap;
  }) => Promise<ProjectShareLink>;
  onRevoke: (link: ProjectShareLink) => Promise<void>;
  onRevokeGrant: (grant: SharedProject) => Promise<void>;
  project: Project;
}) {
  const [scope, setScope] = useState<ShareScope>("anyone");
  const [policy, setPolicy] = useState<ProjectShareModeCap>("standard");
  const [recipientsText, setRecipientsText] = useState("");
  const [error, setError] = useState("");
  const [createdLink, setCreatedLink] = useState<ProjectShareLink | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const activeLinks = links.filter((link) => link.status === "active");

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
            {createdLink?.url ? (
              <div className="rounded-lg border border-[#4d8dff]/40 bg-[#4d8dff]/10 px-3 py-3">
                <p className="mb-2 text-xs text-[var(--muted-foreground)]">
                  Link created. Copy it now — it will not be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    className="h-9 min-w-0 flex-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 font-mono text-xs text-[var(--foreground)]"
                    readOnly
                    value={createdLink.url}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    className={buttonClass}
                    onClick={async () => {
                      await navigator.clipboard.writeText(createdLink.url ?? "");
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    }}
                    type="button"
                  >
                    {copied ? (
                      <Check className="size-3.5" aria-hidden="true" />
                    ) : (
                      <Copy className="size-3.5" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
            ) : null}

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
                    onChange={(event) => setRecipientsText(event.target.value)}
                    placeholder="teammate@example.com, reviewer@example.com"
                    value={recipientsText}
                  />
                </label>
              ) : null}
            </ShareSection>

            <ShareSection label="Sandbox policy">
              <div className="grid gap-2 sm:grid-cols-3">
                {POLICIES.map((option) => (
                  <button
                    aria-pressed={policy === option.value}
                    className={optionClass(policy === option.value)}
                    key={option.value}
                    onClick={() => setPolicy(option.value)}
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

            {error ? (
              <p className="text-xs text-[var(--color-error)]" role="alert">
                {error}
              </p>
            ) : null}

            {activeLinks.length > 0 ? (
              <ShareSection label="Active links">
                <div className="divide-y divide-[var(--color-border-strong)] rounded-md border border-[var(--color-border-strong)]">
                  {activeLinks.map((link) => (
                    <div
                      className="flex items-center gap-3 px-3 py-2.5"
                      key={link.id}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-[var(--foreground)]">
                          {link.sessionId ? "One session" : "Whole project"} ·{" "}
                          {link.modeCap ?? "standard"}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--color-text-passive)]">
                          {link.accessScope === "restricted"
                            ? `Restricted to ${link.recipients.length} recipient${link.recipients.length === 1 ? "" : "s"}`
                            : "Anyone with the link"}
                        </p>
                      </div>
                      <button
                        aria-label="Revoke link"
                        className={iconButtonClass}
                        disabled={busy}
                        onClick={() => void onRevoke(link)}
                        title="Revoke link"
                        type="button"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </ShareSection>
            ) : null}

            {grants.length > 0 ? (
              <ShareSection label="Collaborators">
                <div className="divide-y divide-[var(--color-border-strong)] rounded-md border border-[var(--color-border-strong)]">
                  {grants.map((grant) => (
                    <div
                      className="flex items-center gap-3 px-3 py-2.5"
                      key={grant.grant.id}
                    >
                      <User className="size-3.5 shrink-0 text-[var(--color-text-passive)]" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-[var(--foreground)]">
                          {grant.grant.userDisplayName || grant.grant.userEmail}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--color-text-passive)]">
                          {grant.grant.role}
                          {grant.sessionName ? ` · ${grant.sessionName}` : ""}
                        </p>
                      </div>
                      <button
                        aria-label={`Revoke access for ${grant.grant.userEmail}`}
                        className={iconButtonClass}
                        disabled={busy}
                        onClick={() => void onRevokeGrant(grant)}
                        title="Revoke access"
                        type="button"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </ShareSection>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--color-border-strong)] px-5 py-4">
            <button
              className="h-9 rounded-md px-3 text-xs text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)]"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
            <button
              className="h-9 rounded-md bg-[var(--color-accent-strong)] px-3 text-xs font-semibold text-[var(--color-accent-foreground)] disabled:cursor-not-allowed disabled:opacity-45"
              disabled={busy}
              onClick={async () => {
                setError("");
                const recipients = recipientsText
                  .split(/[,\n]/)
                  .map((email) => email.trim())
                  .filter(Boolean);
                try {
                  const link = await onCreate({
                    accessScope: scope,
                    recipients,
                    modeCap: policy,
                  });
                  setCreatedLink(link);
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "The link could not be created.",
                  );
                }
              }}
              type="button"
            >
              {busy ? "Creating…" : "Create link"}
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

const buttonClass =
  "inline-flex h-9 items-center justify-center rounded-md border border-[var(--color-border-strong)] px-3 text-xs text-[var(--muted-foreground)] hover:bg-[var(--color-interactive-hover)] disabled:cursor-not-allowed disabled:opacity-45";
const iconButtonClass =
  "grid size-8 place-items-center rounded-md text-[var(--color-text-passive)] hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] disabled:opacity-45";
