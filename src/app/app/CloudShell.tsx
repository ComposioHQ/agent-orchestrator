"use client";

import { Menu, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { OrchestratorIcon } from "@/components/icons";

export function CloudMainShell({ children, parity = false }: { children: ReactNode; parity?: boolean }) {
  return (
    <section
      data-testid="cloud-main-shell"
      aria-label="Cloud platform workspace"
      className={`flex min-h-0 min-w-0 bg-[var(--color-bg-sidebar)] ${parity ? "p-2 pl-0 sm:p-3 sm:pl-0" : "p-[6px] pl-0"}`}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] transition-[border-color,border-radius] duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] motion-reduce:transition-none">
        {children}
      </div>
    </section>
  );
}

export function CloudTopbar({
  title,
  onOpenSidebar,
  onNewTask,
  onOrchestrator,
  onDelete,
  showBoardActions = false,
}: {
  title: string;
  onOpenSidebar?: () => void;
  onNewTask?: () => void;
  onOrchestrator?: () => void;
  onDelete?: () => void;
  showBoardActions?: boolean;
}) {
  return (
    <header
      aria-label="Project toolbar"
      className="relative z-10 flex h-10 shrink-0 items-center gap-3 border-b border-[var(--color-border-strong)] pl-3 pr-2.5 sm:pl-[18px]"
    >
      {onOpenSidebar ? (
        <button
          type="button"
          aria-label="Open navigation"
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] lg:hidden"
          onClick={onOpenSidebar}
        >
          <Menu className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      <h1 className="min-w-0 truncate text-sm font-semibold leading-none tracking-[-0.02em] text-[var(--foreground)]">
        {title}
      </h1>

      <div className="min-w-0 flex-1" />

      <div className="flex shrink-0 items-center gap-1.5">
        {showBoardActions ? (
          <>
            {onNewTask ? (
              <button
                type="button"
                aria-label="New task"
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--muted)] px-2.5 text-xs font-semibold leading-none text-[var(--muted-foreground)] transition-[filter,background,color] duration-100 hover:bg-[var(--card)] hover:text-[var(--foreground)]"
                onClick={onNewTask}
              >
                <Plus className="size-[18px]" aria-hidden="true" />
                New task
              </button>
            ) : null}
            {onOrchestrator ? (
              <button
                type="button"
                aria-label="Orchestrator"
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-[var(--color-accent-strong)] px-2.5 text-xs font-semibold leading-none text-[var(--color-accent-foreground)] transition-[filter] duration-100 hover:brightness-110 active:brightness-95"
                onClick={onOrchestrator}
              >
                <OrchestratorIcon className="size-[18px]" aria-hidden="true" />
                Orchestrator
              </button>
            ) : null}
          </>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            aria-label="Delete"
            className="grid size-[34px] cursor-pointer place-items-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)]"
            onClick={onDelete}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
