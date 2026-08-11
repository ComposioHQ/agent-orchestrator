"use client";

import { Bell, Plus } from "lucide-react";
import type { ReactNode } from "react";

import { OrchestratorIcon } from "./OrchestratorIcon";

export function CloudDemoMainShell({ children }: { children: ReactNode }) {
  return (
    <section
      data-testid="cloud-main-shell"
      aria-label="Cloud platform workspace"
      className="flex min-h-0 min-w-0 bg-[var(--color-bg-sidebar)] p-[6px] pl-0"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[var(--color-border-strong)] bg-[var(--color-bg-primary)] transition-[border-color,border-radius] duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] motion-reduce:transition-none">
        {children}
      </div>
    </section>
  );
}

export function CloudDemoTopbar({ title }: { title: string }) {
  return (
    <header
      aria-label="Project toolbar"
      className="relative z-10 flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-border-strong)] pl-[18px] pr-4"
    >
      <h1 className="min-w-0 truncate text-sm font-semibold leading-none tracking-[-0.02em] text-[var(--foreground)]">
        {title}
      </h1>

      <div className="min-w-0 flex-1" />

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          aria-label="New task"
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--color-bg-tertiary)] px-3.5 py-2.5 text-sm font-semibold leading-none text-[var(--muted-foreground)] transition-[filter,background-color,color,border-color,transform] duration-150 hover:bg-[var(--color-bg-secondary)] hover:text-[var(--foreground)] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transform-none motion-reduce:transition-none"
        >
          <Plus className="size-[15px]" aria-hidden="true" />
          <span className="max-[760px]:hidden">New task</span>
        </button>

        <button
          type="button"
          aria-label="Open orchestrator"
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md bg-[var(--color-accent-strong)] px-3.5 py-2.5 text-sm font-semibold leading-none text-[var(--color-accent-foreground)] transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transform-none motion-reduce:transition-none"
        >
          <OrchestratorIcon className="size-[15px]" strokeWidth={2} aria-hidden="true" />
          <span className="max-[760px]:hidden">Orchestrator</span>
        </button>

        <button
          type="button"
          aria-label="Notifications"
          title="Notifications"
          className="grid size-9 cursor-pointer place-items-center rounded-md py-2.5 text-[var(--muted-foreground)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] motion-reduce:transform-none motion-reduce:transition-none"
        >
          <Bell className="size-[15px]" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
