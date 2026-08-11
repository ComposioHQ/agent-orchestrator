"use client";

import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

const demoWorkspaces = [
  { id: "personal", name: "Personal workspace", role: "owner" },
  { id: "team", name: "AO Team", role: "admin" },
] as const;

export function CloudDemoWorkspaceSwitcher() {
  const prefersReducedMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    demoWorkspaces[0].id,
  );
  const selectedWorkspace =
    demoWorkspaces.find(({ id }) => id === selectedWorkspaceId) ??
    demoWorkspaces[0];

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const menuTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.16, ease: [0.25, 0.46, 0.45, 0.94] as const };

  return (
    <div ref={rootRef} className="relative mx-2 mb-2">
      <motion.button
        type="button"
        aria-label="Switch workspace"
        aria-haspopup="menu"
        aria-expanded={open}
        whileTap={prefersReducedMotion ? undefined : { scale: 0.985 }}
        transition={{ duration: 0.1, ease: "easeOut" }}
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] px-2.5 text-left text-[var(--foreground)] transition-[background-color,border-color] duration-150 hover:border-[var(--border)] hover:bg-[var(--color-interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-none">
          {selectedWorkspace.name}
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={menuTransition}
          className="inline-flex shrink-0 text-[var(--color-text-passive)]"
        >
          <ChevronsUpDown className="size-3.5" aria-hidden="true" />
        </motion.span>
      </motion.button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            role="menu"
            aria-label="Workspaces"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.985 }}
            transition={menuTransition}
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 origin-top overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
          >
            <div className="truncate px-2 py-1.5 text-[11px] leading-4 text-[var(--color-text-passive)]">
              you@company.com
            </div>
            {demoWorkspaces.map((workspace) => {
              const selected = workspace.id === selectedWorkspaceId;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-[background-color,color,transform] duration-100 hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none ${
                    selected
                      ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]"
                      : "text-[var(--muted-foreground)]"
                  }`}
                  onClick={() => {
                    setSelectedWorkspaceId(workspace.id);
                    setOpen(false);
                  }}
                >
                  <Building2
                    className="size-3.5 shrink-0 text-[var(--color-text-passive)]"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {workspace.name}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.04em] text-[var(--color-text-passive)]">
                    {workspace.role}
                  </span>
                  {selected ? (
                    <Check
                      className="size-3.5 shrink-0 text-[var(--muted-foreground)]"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              );
            })}
            <div className="my-1 h-px bg-[var(--color-border-strong)]" />
            <button
              type="button"
              role="menuitem"
              className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-[var(--muted-foreground)] transition-[background-color,color,transform] duration-100 hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none"
              onClick={() => setOpen(false)}
            >
              <Plus
                className="size-3.5 shrink-0 text-[var(--color-text-passive)]"
                aria-hidden="true"
              />
              <span className="truncate">Create workspace</span>
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
