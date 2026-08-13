"use client";

import type { CurrentAccount } from "@aoagents/cloud-client";
import { Check, ChevronsUpDown, LogOut, Settings } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

const PALETTE = [
  { bg: "oklch(0.35 0.12 250)", fg: "oklch(0.78 0.10 250)" },  // blue
  { bg: "oklch(0.35 0.12 150)", fg: "oklch(0.78 0.10 150)" },  // green
  { bg: "oklch(0.35 0.12 320)", fg: "oklch(0.78 0.10 320)" },  // pink
  { bg: "oklch(0.35 0.10 60)",  fg: "oklch(0.78 0.08 60)" },   // amber
  { bg: "oklch(0.35 0.12 280)", fg: "oklch(0.78 0.10 280)" },  // purple
  { bg: "oklch(0.35 0.12 180)", fg: "oklch(0.78 0.10 180)" },  // teal
  { bg: "oklch(0.35 0.12 20)",  fg: "oklch(0.78 0.10 20)" },   // red
  { bg: "oklch(0.35 0.10 100)", fg: "oklch(0.78 0.08 100)" },  // lime
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function WorkspaceAvatar({ name, id, size = 18 }: { name: string; id: string; size?: number }) {
  const colors = PALETTE[hashString(id) % PALETTE.length]!;
  const initials = name.slice(0, 2).toUpperCase();
  const fontSize = size * 0.42;
  const radius = size * 0.22;

  return (
    <span
      className="inline-grid shrink-0 place-items-center font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: colors.bg,
        color: colors.fg,
        fontSize,
        lineHeight: 1,
      }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

const menuItemClass =
  "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-[var(--muted-foreground)] transition-[background-color,color] duration-75 hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] active:scale-[0.98] focus-visible:outline-none";

export function CloudWorkspaceSwitcher({
  account,
  onOpenSettings,
  onSelect,
  selectedOrganizationId,
}: {
  account: CurrentAccount;
  onOpenSettings: () => void;
  onSelect: (organizationId: string) => void;
  selectedOrganizationId: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedWorkspace =
    account.organizations.find(
      ({ id }) => id === selectedOrganizationId,
    ) ?? account.organizations[0];

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
    : { duration: 0.1, ease: [0.25, 0.46, 0.45, 0.94] as const };

  return (
    <div ref={rootRef} className="relative mx-2 mb-2 mt-3">
      <motion.button
        type="button"
        aria-label="Switch workspace"
        aria-haspopup="menu"
        aria-expanded={open}
        whileTap={prefersReducedMotion ? undefined : { scale: 0.985 }}
        transition={{ duration: 0.06, ease: "easeOut" }}
        data-state={open ? "open" : "closed"}
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] px-2.5 text-left text-sm font-normal text-[var(--muted-foreground)] transition-[background-color,color] duration-150 ease-out hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:text-[var(--foreground)] data-[state=open]:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] data-[state=open]:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none"
        onClick={() => setOpen((current) => !current)}
      >
        {selectedWorkspace ? (
          <WorkspaceAvatar name={selectedWorkspace.displayName} id={selectedWorkspace.id} />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-none">
          {selectedWorkspace?.displayName ?? "No organization"}
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
            aria-label="Workspace menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -3, scale: 0.99 }}
            transition={menuTransition}
            className="absolute left-0 top-[calc(100%+6px)] z-50 w-[calc(100%+24px)] origin-top overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-bg-secondary)] p-1"
          >
            <div>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                <Settings className="size-3.5 shrink-0" aria-hidden="true" />
                Settings
              </button>
              <a
                role="menuitem"
                href="/sign-out"
                className={menuItemClass}
              >
                <LogOut className="size-3.5 shrink-0" aria-hidden="true" />
                Sign out
              </a>
            </div>

            {/* Workspace list */}
            <div className="border-t border-[var(--color-border-strong)] pt-1.5">
              <div className="truncate px-2 py-1.5 text-[11px] leading-4 text-[var(--color-text-passive)]">
                {account.user.email}
              </div>
              {account.organizations.map((workspace) => {
                const selected = workspace.id === selectedOrganizationId;
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`${menuItemClass} ${
                      selected
                        ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]"
                        : ""
                    }`}
                    onClick={() => {
                      onSelect(workspace.id);
                      setOpen(false);
                    }}
                  >
                    <WorkspaceAvatar name={workspace.displayName} id={workspace.id} />
                    <span className="min-w-0 flex-1 truncate">
                      {workspace.displayName}
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
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
