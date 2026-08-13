"use client";

import type { Project } from "@aoagents/cloud-client";
import { Copy, Link, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

type ShareScope = "anyone" | "restricted";
type SharePolicy = "read-only" | "standard" | "trusted";

export function CloudShareDialog({
  onClose,
  open,
  project,
}: {
  onClose: () => void;
  open: boolean;
  project: Project | null;
}) {
  const [scope, setScope] = useState<ShareScope>("anyone");
  const [policy, setPolicy] = useState<SharePolicy>("standard");
  const [copied, setCopied] = useState(false);

  const copyLink = () => {
    const url = `${window.location.origin}/share/${project?.id ?? ""}`;
    void navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[100] w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-visible rounded-lg bg-[var(--card)] text-[var(--foreground)] shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none"
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

          <div className="space-y-5 p-5">
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
                    className="mt-1.5 min-h-20 w-full resize-y rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--color-text-passive)]"
                    placeholder="teammate@example.com, reviewer@example.com"
                  />
                </label>
              ) : null}
            </ShareSection>

            <ShareSection label="Sandbox policy">
              <div className="grid gap-2 sm:grid-cols-3">
                {([
                  { value: "read-only" as const, label: "Read only", description: "View-only access" },
                  { value: "standard" as const, label: "Standard", description: "Selected-worker editing" },
                  { value: "trusted" as const, label: "Trusted", description: "Full interaction" },
                ] as const).map((option) => (
                  <button
                    aria-pressed={policy === option.value}
                    className={optionClass(policy === option.value)}
                    key={option.value}
                    onClick={() => setPolicy(option.value)}
                    type="button"
                  >
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--color-text-passive)]">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
            </ShareSection>

            <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--color-interactive-active)] px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
                <Link className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate font-mono">
                  {window.location.origin}/share/{project?.id?.slice(0, 8) ?? "..."}
                </span>
              </div>
              <button
                type="button"
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-[var(--color-accent-strong)] px-2.5 text-xs font-semibold text-[var(--color-accent-foreground)]"
                onClick={copyLink}
              >
                <Copy className="size-3" aria-hidden="true" />
                {copied ? "Copied" : "Copy link"}
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
  return `cursor-pointer rounded-lg px-3 py-2.5 text-left transition-colors ${
    selected
      ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]"
      : "bg-[var(--color-interactive-hover)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
  }`;
}
