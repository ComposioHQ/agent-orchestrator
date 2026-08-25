"use client";

import { type FormEvent, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Input } from "@/components/ui/input";

export function CloudCreateWorkspaceDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (displayName: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setName("");
    setBusy(false);
    setError("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(name.trim());
      reset();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create workspace.");
      setBusy(false);
    }
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => { if (!next) { reset(); onClose(); } }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-[100] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[var(--card)] text-[var(--foreground)] shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none"
        >
          <div className="flex items-center justify-between px-5 pt-4 pb-0">
            <DialogPrimitive.Title className="text-sm font-semibold">
              Create workspace
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Create a new AO Cloud workspace.
            </DialogPrimitive.Description>
            <DialogPrimitive.Close className="grid size-7 place-items-center rounded-md text-[var(--color-text-passive)] hover:text-[var(--foreground)]">
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-4 p-5">
            <label className="block">
              <span className="mb-1.5 block text-xs text-[var(--muted-foreground)]">
                Workspace name
              </span>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My team"
                required
              />
            </label>

            {error ? (
              <p className="text-xs text-[var(--color-error)]" role="alert">{error}</p>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="submit"
                className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md bg-[var(--color-accent-strong)] px-4 text-xs font-semibold text-[var(--color-accent-foreground)] disabled:opacity-50"
                disabled={busy || !name.trim()}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
