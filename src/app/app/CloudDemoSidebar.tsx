"use client";

import { ChevronRight, Folder, FolderOpen, MoreVertical, Plus, Search, Settings } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import { OrchestratorIcon } from "./OrchestratorIcon";
import { CloudDemoWorkspaceSwitcher } from "./CloudDemoWorkspaceSwitcher";
import type { DemoSession } from "./demo-types";

export function CloudDemoSidebar({
  sessions,
  onOpenCommand,
  onOpenSettings,
}: {
  sessions: DemoSession[];
  onOpenCommand: () => void;
  onOpenSettings: () => void;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [projectOpen, setProjectOpen] = useState(true);
  const [projectHovered, setProjectHovered] = useState(false);
  const [projectPressed, setProjectPressed] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  return (
    <aside className="flex min-h-0 flex-col bg-[var(--color-bg-sidebar)]">
      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2 pt-2">
        <button type="button" aria-label="Orchestrator board" className="grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
          <img src="/ao-logo.svg" alt="" aria-hidden="true" className="size-[22px] -translate-y-[3px] rounded-md object-cover" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-bold leading-tight tracking-[-0.025em]">Agent Orchestrator</span>
      </div>

      <CloudDemoWorkspaceSwitcher />

      <div className="px-2 pb-4">
        <button
          type="button"
          aria-label="Search"
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-bg-primary)] px-2.5 text-sm font-normal text-[var(--muted-foreground)] transition-[background-color,color,transform] duration-150 ease-out hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] active:scale-[0.98] active:bg-[var(--color-interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none"
          onClick={onOpenCommand}
        >
          <Search className="size-4" strokeWidth={1.75} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left leading-none">Search</span>
          <kbd className="ml-auto shrink-0 rounded-sm border border-white/10 bg-white/[0.025] px-1.5 py-0.5 font-mono text-[10px] leading-none text-[var(--muted-foreground)]">⌘ K</kbd>
        </button>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-2 px-4 text-sm font-medium text-[var(--color-text-passive)]">
        <span className="min-w-0 flex-1 truncate">Projects</span>
        <button type="button" aria-label="New project" className="grid size-5 cursor-pointer place-items-center rounded-sm transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <div
          className="relative"
          onMouseEnter={() => setProjectHovered(true)}
          onMouseLeave={() => {
            setProjectHovered(false);
            setProjectPressed(false);
          }}
        >
          <motion.div
            animate={{ scale: projectPressed ? 0.98 : 1 }}
            initial={false}
            transition={{ duration: prefersReducedMotion ? 0 : 0.1, ease: "easeOut" }}
          >
            <button
              type="button"
              aria-expanded={projectOpen}
              className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-interactive-active)] px-2.5 pr-14 text-left text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              onClick={() => setProjectOpen((open) => !open)}
              onPointerCancel={() => setProjectPressed(false)}
              onPointerDown={() => setProjectPressed(true)}
              onPointerUp={() => setProjectPressed(false)}
            >
              <span className="relative inline-flex size-4 shrink-0 translate-y-px items-center justify-center text-[var(--muted-foreground)]">
                {projectHovered ? (
                  <motion.span
                    animate={{ rotate: projectOpen ? 90 : 0 }}
                    initial={false}
                    transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.14, ease: [0.25, 0.46, 0.45, 0.94] }}
                    className="inline-flex size-4 items-center justify-center"
                  >
                    <ChevronRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
                  </motion.span>
                ) : projectOpen ? (
                  <FolderOpen className="size-4" strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Folder className="size-4" strokeWidth={1.75} aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0 flex-1 translate-y-px truncate">Cloud platform</span>
            </button>
          </motion.div>
          <div className="absolute inset-y-0 right-1 flex items-center gap-px">
            <button type="button" aria-label="Open project orchestrator" className="grid size-5 cursor-pointer place-items-center rounded-md text-[var(--color-text-passive)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
              <OrchestratorIcon className="size-4" strokeWidth={2} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Project actions" className="grid size-5 cursor-pointer place-items-center rounded-md text-[var(--color-text-passive)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]">
              <MoreVertical className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {projectOpen ? (
            <motion.div
              key="sessions"
              initial={{ height: 0 }}
              animate={{ height: "auto" }}
              exit={{ height: 0 }}
              transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.14, ease: [0.25, 0.46, 0.45, 0.94] }}
              className="overflow-hidden"
            >
              <motion.div
                initial={{ y: -12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -12, opacity: 0 }}
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.14, ease: [0.25, 0.46, 0.45, 0.94] }}
                className="ml-3.5 py-1"
              >
                {sessions.map((session) => {
                  const dot =
                    session.activityState === "active"
                      ? "bg-[#60a5fa]"
                      : session.activityState === "waiting_input" || session.activityState === "blocked"
                        ? "bg-[#fb923c]"
                        : session.activityState === "exited"
                          ? "bg-[var(--destructive)]"
                          : "bg-[var(--muted-foreground)]";
                  const active = selectedSessionId === session.id;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className={`flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-left text-sm transition-[background-color,color,transform] duration-100 ease-out hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transition-none ${active ? "bg-[var(--color-interactive-active)] text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}`}
                      onClick={() => setSelectedSessionId(session.id)}
                    >
                      <motion.span
                        className={`size-2 shrink-0 rounded-full ${dot}`}
                        animate={session.activityState === "active" && !prefersReducedMotion ? { opacity: [1, 0.35, 1] } : undefined}
                        transition={session.activityState === "active" && !prefersReducedMotion ? { duration: 1.8, ease: "easeInOut", repeat: Infinity } : undefined}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{session.displayName}</span>
                    </button>
                  );
                })}
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="mt-auto border-t border-[var(--color-border-strong)] px-2 py-2">
        <button
          type="button"
          aria-label="Settings"
          className="flex h-[42px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          onClick={onOpenSettings}
        >
          <Settings className="size-4 shrink-0" aria-hidden="true" />
          <span className="tracking-tight">Settings</span>
        </button>
      </div>
    </aside>
  );
}
