"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import { Dialog as DialogPrimitive, DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

type Harness = "claude-code" | "codex" | "cursor";

const AGENTS: Array<{ value: Harness; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
];

export function CloudNewSessionDialog({
  open,
  projectName,
  connectedProviders,
  onClose,
  onCreate,
}: {
  open: boolean;
  projectName: string;
  connectedProviders: string[];
  onClose: () => void;
  onCreate: (input: { displayName: string; harness: Harness; prompt: string }) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [harness, setHarness] = useState<Harness>("claude-code");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const reset = () => {
    setPrompt("");
    setHarness("claude-code");
    setIsSubmitting(false);
    setError(undefined);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(undefined);
    try {
      const name = prompt.trim().slice(0, 60) || "New session";
      await onCreate({ displayName: name, harness, prompt: prompt.trim() });
      reset();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create session.");
      setIsSubmitting(false);
    }
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) { reset(); onClose(); }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[100] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--border)] bg-[var(--popover)] p-0 text-[var(--foreground)] shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none"
          onPointerDownOutside={(e) => { if (dropdownOpen) e.preventDefault(); }}
          onInteractOutside={(e) => { if (dropdownOpen) e.preventDefault(); }}
        >
          <div className="flex items-center justify-between px-4 pt-3">
            <DialogPrimitive.Title className="text-sm font-semibold">
              New task
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Create a new agent session in {projectName}.
            </DialogPrimitive.Description>
            <DialogPrimitive.Close className="grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:text-[var(--foreground)]">
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>

          <form onSubmit={submit} className="flex flex-col">
            <textarea
              autoFocus
              className="min-h-[112px] w-full resize-none bg-transparent px-4 pb-3 pt-3 text-sm leading-relaxed text-[var(--foreground)] outline-none placeholder:text-[var(--color-text-passive)]"
              placeholder="Describe the task…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />

            {error ? (
              <div className="mx-3 mb-2 rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)]">
                {error}
              </div>
            ) : null}

            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 pb-3">
              <div className="composer-run-controls">
                <div className="min-w-0">
                  <ComposerDropdown
                    icon={<AgentIcon harness={harness} disabled={!connectedProviders.includes(harness)} />}
                    label={AGENTS.find((a) => a.value === harness)?.label ?? harness}
                    onOpenChange={setDropdownOpen}
                  >
                    {AGENTS.map((a) => {
                      const disabled = !connectedProviders.includes(a.value);
                      return (
                        <DropdownMenuPrimitive.Item
                          key={a.value}
                          disabled={disabled}
                          onSelect={() => setHarness(a.value)}
                          className={`flex h-8 w-full cursor-default items-center gap-2 rounded-lg px-2.5 text-[13px] outline-none transition-colors ${
                            disabled
                              ? "opacity-40"
                              : a.value === harness
                                ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]"
                                : "text-[var(--muted-foreground)] data-highlighted:bg-[var(--color-interactive-hover)] data-highlighted:text-[var(--foreground)]"
                          }`}
                        >
                          <AgentIcon harness={a.value} disabled={disabled} />
                          {a.label}
                        </DropdownMenuPrimitive.Item>
                      );
                    })}
                  </ComposerDropdown>
                </div>
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex h-[38px] min-w-[7.25rem] cursor-pointer items-center justify-center gap-2 rounded-md bg-[var(--color-accent-strong)] px-3 text-sm font-semibold text-[var(--color-accent-foreground)] disabled:opacity-50"
              >
                {isSubmitting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                {isSubmitting ? "Starting…" : "Start"}
                {!isSubmitting ? (
                  <kbd className="inline-flex min-w-4 items-center justify-center font-mono text-base leading-none opacity-75" aria-hidden="true">↵</kbd>
                ) : null}
              </button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function AgentIcon({ harness, disabled, className }: { harness: string; disabled?: boolean; className?: string }) {
  return (
    <img
      src={`/agents/${harness}.svg`}
      alt=""
      aria-hidden="true"
      className={`size-4 shrink-0 rounded-sm object-contain ${disabled ? "opacity-30 grayscale" : ""} ${className ?? ""}`}
    />
  );
}

function ComposerDropdown({
  icon,
  label,
  children,
  onOpenChange,
}: {
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenuPrimitive.Root onOpenChange={onOpenChange}>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          className="composer-toolbar-option group/chip flex h-[38px] w-full cursor-pointer items-center gap-1.5 px-2.5 text-sm text-[var(--muted-foreground)] outline-none focus:outline-none focus-visible:ring-0 data-[state=open]:outline-none"
        >
          {icon}
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="ml-auto size-3 shrink-0 text-[var(--color-text-passive)] transition-transform duration-300 ease-out group-data-[state=open]/chip:rotate-180" aria-hidden="true" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-[200] min-w-[280px] animate-popover-in rounded-[12px] border border-[var(--border)] bg-[color-mix(in_oklab,var(--popover)_88%,var(--foreground)_12%)] p-1 data-[state=closed]:animate-popover-out"
        >
          {children}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
