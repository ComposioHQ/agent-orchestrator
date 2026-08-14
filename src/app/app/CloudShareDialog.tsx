"use client";

import type { Project } from "@aoagents/cloud-client";
import { Check, Copy, Trash2, User, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ProjectShareLink, ProjectShareModeCap, SharedProject } from "./share-types";

type ShareScope = "anyone" | "restricted";

const POLICIES: Array<{
  value: ProjectShareModeCap;
  label: string;
  description: string;
}> = [
  { value: "read-only", label: "Read only", description: "View-only access" },
  { value: "standard", label: "Standard", description: "Selected-worker editing" },
  { value: "trusted", label: "Trusted", description: "Full interaction" },
];

export function CloudShareDialog({
  busy = false,
  grants = [],
  links = [],
  onClose,
  onCreate = async () => { throw new Error("Sharing is unavailable."); },
  onRevoke = async () => {},
  onRevokeGrant = async () => {},
  open = false,
  project,
}: {
  busy?: boolean;
  grants?: SharedProject[];
  links?: ProjectShareLink[];
  onClose: () => void;
  onCreate?: (input: { accessScope: ShareScope; recipients: string[]; modeCap: ProjectShareModeCap }) => Promise<ProjectShareLink>;
  onRevoke?: (link: ProjectShareLink) => Promise<void>;
  onRevokeGrant?: (grant: SharedProject) => Promise<void>;
  open?: boolean;
  project: Project | null;
}) {
  const [scope, setScope] = useState<ShareScope>("anyone");
  const [policy, setPolicy] = useState<ProjectShareModeCap>("standard");
  const [recipientsText, setRecipientsText] = useState("");
  const [error, setError] = useState("");
  const [createdLink, setCreatedLink] = useState<ProjectShareLink | null>(null);
  const [copied, setCopied] = useState(false);

  const activeLinks = links.filter((link) => link.status === "active");
  const createdLinkURL =
    createdLink?.token && project && typeof window !== "undefined"
      ? `${window.location.origin}/share/${project.orgId}/${createdLink.token}`
      : undefined;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[100] w-[min(560px,calc(100vw-2rem))] max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg bg-[var(--card)] text-[var(--foreground)] shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none"
        >
          <div className="flex items-center justify-between px-5 pt-4 pb-0">
            <DialogPrimitive.Title className="text-sm font-semibold">
              Share {project?.displayName}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Share this project with others.
            </DialogPrimitive.Description>
            <DialogPrimitive.Close className="grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:text-[var(--foreground)]">
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>

          <div className="max-h-[calc(85vh-56px)] overflow-y-auto">
            <div className="space-y-5 p-5">
              {createdLinkURL ? (
                <div className="rounded-lg border border-[var(--ring)]/40 bg-[var(--ring)]/10 px-3 py-3">
                  <p className="mb-2 text-xs text-[var(--muted-foreground)]">
                    Link created. Copy it now — it will not be shown again.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      className="h-8 min-w-0 flex-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 font-mono text-xs text-[var(--foreground)]"
                      readOnly
                      value={createdLinkURL}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-[var(--color-accent-strong)] px-2.5 text-xs font-semibold text-[var(--color-accent-foreground)]"
                      onClick={async () => {
                        await navigator.clipboard.writeText(createdLinkURL);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1500);
                      }}
                      type="button"
                    >
                      {copied ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              ) : null}

              <ShareSection label="Access">
                <div className="grid gap-2 sm:grid-cols-2">
                  {([
                    { value: "anyone" as const, label: "Anyone with the link", description: "Anyone who receives the link may redeem it." },
                    { value: "restricted" as const, label: "Restricted", description: "Limit to invited email addresses." },
                  ] as const).map((option) => (
                    <button
                      aria-pressed={scope === option.value}
                      className={optionClass(scope === option.value)}
                      key={option.value}
                      onClick={() => setScope(option.value)}
                      type="button"
                    >
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-[var(--color-text-passive)]">{option.description}</span>
                    </button>
                  ))}
                </div>
                {scope === "restricted" ? (
                  <label className="mt-3 block text-xs text-[var(--muted-foreground)]">
                    Recipient emails
                    <textarea
                      className="mt-1.5 min-h-20 w-full resize-y rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--color-text-passive)]"
                      onChange={(e) => setRecipientsText(e.target.value)}
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
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-[var(--color-text-passive)]">{option.description}</span>
                    </button>
                  ))}
                </div>
              </ShareSection>

              {error ? <p className="text-xs text-[var(--color-error)]" role="alert">{error}</p> : null}

              {activeLinks.length > 0 ? (
                <ShareSection label="Active links">
                  <div className="space-y-1">
                    {activeLinks.map((link) => (
                      <div className="flex items-center gap-3 rounded-lg bg-[var(--color-interactive-hover)] px-3 py-2.5" key={link.id}>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-[var(--foreground)]">
                            {link.sessionId ? "One session" : "Whole project"} · {link.modeCap ?? "standard"}
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--color-text-passive)]">
                            {link.accessScope === "restricted" ? `Restricted to ${link.recipients.length} recipient${link.recipients.length === 1 ? "" : "s"}` : "Anyone with the link"}
                          </p>
                        </div>
                        <button
                          aria-label="Revoke link"
                          className="grid size-7 cursor-pointer place-items-center rounded-md text-[var(--color-text-passive)] hover:text-[var(--destructive)]"
                          disabled={busy}
                          onClick={() => void onRevoke(link)}
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
                  <div className="space-y-1">
                    {grants.map((grant) => (
                      <div className="flex items-center gap-3 rounded-lg bg-[var(--color-interactive-hover)] px-3 py-2.5" key={grant.grant.id}>
                        <User className="size-3.5 shrink-0 text-[var(--color-text-passive)]" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-[var(--foreground)]">
                            {grant.grant.userDisplayName || grant.grant.userEmail}
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--color-text-passive)]">
                            {grant.grant.role}{grant.sessionName ? ` · ${grant.sessionName}` : ""}
                          </p>
                        </div>
                        <button
                          aria-label={`Revoke access for ${grant.grant.userEmail}`}
                          className="grid size-7 cursor-pointer place-items-center rounded-md text-[var(--color-text-passive)] hover:text-[var(--destructive)]"
                          disabled={busy}
                          onClick={() => void onRevokeGrant(grant)}
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

            <div className="flex justify-end gap-2 px-5 pb-5">
              <button
                className="h-8 cursor-pointer rounded-md bg-[var(--color-accent-strong)] px-4 text-xs font-semibold text-[var(--color-accent-foreground)] disabled:opacity-50"
                disabled={busy}
                onClick={async () => {
                  setError("");
                  const recipients = recipientsText.split(/[,\n]/).map((e) => e.trim()).filter(Boolean);
                  try {
                    const link = await onCreate({ accessScope: scope, recipients, modeCap: policy });
                    setCreatedLink(link);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "The link could not be created.");
                  }
                }}
                type="button"
              >
                {busy ? "Creating…" : "Create link"}
              </button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ShareSection({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">{label}</h3>
      {children}
    </section>
  );
}

function optionClass(selected: boolean) {
  return `flex flex-1 cursor-pointer flex-col items-stretch rounded-lg px-3 py-2.5 text-left transition-colors ${
    selected
      ? "border border-[var(--ring)]/40 bg-[var(--ring)]/10 text-[var(--foreground)]"
      : "border border-transparent bg-[var(--color-interactive-hover)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
  }`;
}
