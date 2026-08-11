"use client";

import { Folder, Search, Settings, Settings2, SquarePen, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import { OrchestratorIcon } from "./OrchestratorIcon";

const commands = [
  { label: "New task", detail: "Cloud platform", icon: SquarePen },
  { label: "Open Cloud platform", detail: "Project", icon: Folder },
  { label: "Open Settings", detail: "Application", icon: Settings },
];

export function CloudDemoCommandMenu({
  open,
  onClose,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const visibleCommands = commands.filter(({ label, detail }) =>
    `${label} ${detail}`.toLowerCase().includes(query.toLowerCase()),
  );

  const selectCommand = (label: string) => {
    onClose();
    if (label === "Open Settings") onOpenSettings();
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-black/55 px-4 pt-[14vh] backdrop-blur-[2px]"
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.08, ease: [0.23, 1, 0.32, 1] }}
          onMouseDown={(event) => event.currentTarget === event.target && onClose()}
        >
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label="Command menu"
            className="w-full max-w-[720px] overflow-hidden rounded-[12px] border border-[var(--color-border-command-palette)] bg-[var(--color-bg-command-palette)] shadow-[var(--shadow-command-palette)]"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.12, ease: [0.23, 1, 0.32, 1] }}
          >
            <div className="flex items-center gap-2.5 border-b border-[var(--color-border-command-palette)] px-5 py-3">
              <Search className="size-4 text-[var(--color-text-passive)]" aria-hidden="true" />
              <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands and projects…" aria-label="Search commands" className="h-6 min-w-0 flex-1 bg-transparent text-base leading-6 text-[var(--foreground)] caret-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]" />
              <kbd className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-passive)]">esc</kbd>
            </div>
            <div className="max-h-[min(420px,50vh)] overflow-y-auto py-1">
              <p className="px-5 pb-1 pt-2.5 text-[11px] font-normal tracking-wide text-[var(--muted-foreground)]">Commands</p>
              {visibleCommands.map(({ label, detail, icon: Icon }, index) => (
                <button key={label} type="button" className={`mx-2 flex w-[calc(100%-1rem)] cursor-pointer items-center gap-2.5 rounded-md py-1.5 pl-3.5 pr-2.5 text-left text-[13px] leading-[22px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${index === 0 ? "bg-[var(--color-bg-command-item-active)] text-[var(--foreground)]" : "text-[var(--foreground)] hover:bg-[var(--color-bg-command-item-active)]"}`} onClick={() => selectCommand(label)}>
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  <span>{label}</span>
                  <span className="ml-auto text-xs text-[var(--color-text-passive)]">{detail}</span>
                </button>
              ))}
              {visibleCommands.length === 0 ? <p className="px-2.5 py-8 text-center text-sm text-[var(--color-text-passive)]">No commands found.</p> : null}
            </div>
            <footer className="flex items-center gap-4 border-t border-[var(--color-border-command-palette)] px-5 pb-3 pt-3 text-sm text-[var(--muted-foreground)]"><span>↑↓ Navigate</span><span>↵ Select</span></footer>
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function CloudDemoSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prefersReducedMotion = useReducedMotion();
  return (
    <AnimatePresence>
      {open ? (
        <motion.div className="fixed inset-0 z-[100] grid place-items-center bg-black/55 p-6 backdrop-blur-[2px]" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: prefersReducedMotion ? 0 : 0.08, ease: [0.23, 1, 0.32, 1] }} onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
          <motion.section role="dialog" aria-modal="true" aria-label="Settings" className="w-full max-w-2xl overflow-hidden rounded-xl border border-white/10 bg-[var(--color-bg-elevated)] shadow-[0_24px_80px_rgba(0,0,0,0.6)]" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: prefersReducedMotion ? 0 : 0.12, ease: [0.23, 1, 0.32, 1] }}>
            <div className="grid min-h-96 grid-cols-[192px_1fr]"><aside className="flex flex-col border-r border-white/[0.07] bg-[var(--card)]"><p className="px-3 pb-1 pt-3 text-[10px] font-semibold tracking-wider text-[var(--muted-foreground)]/60">Settings</p><nav className="flex flex-col gap-0.5 p-2 pt-0"><button type="button" className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-interactive-active)] px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"><Settings2 className="size-4" aria-hidden="true" />General</button><button type="button" className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-3 text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"><OrchestratorIcon className="size-4" aria-hidden="true" />Agents</button></nav></aside><div className="flex min-w-0 flex-col bg-[var(--card)]"><header className="flex items-center justify-between px-6 pb-3 pt-5"><h2 className="text-2xl font-bold text-[var(--foreground)]">General</h2><button type="button" aria-label="Close settings" className="grid size-8 cursor-pointer place-items-center rounded-lg border border-transparent text-[var(--color-text-passive)] transition-colors hover:border-white/10 hover:bg-[var(--input)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]" onClick={onClose}><X className="size-4" aria-hidden="true" /></button></header><div className="px-6 pb-6"><p className="text-sm leading-6 text-[var(--muted-foreground)]">Cloud workspace preferences and account settings.</p></div></div></div>
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
