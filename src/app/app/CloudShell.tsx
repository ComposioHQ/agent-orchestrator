"use client";

import { Menu } from "lucide-react";
import type { ReactNode } from "react";

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

export function CloudTopbar({ title, onOpenSidebar }: { title: string; onOpenSidebar?: () => void }) {
  return (
    <header
      aria-label="Project toolbar"
      className="relative z-10 flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-border-strong)] pl-3 pr-3 sm:pl-[18px] sm:pr-4"
    >
      {onOpenSidebar ? (
        <button
          type="button"
          aria-label="Open navigation"
          className="grid size-8 shrink-0 place-items-center rounded-md text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-interactive-hover)] hover:text-[var(--foreground)] lg:hidden"
          onClick={onOpenSidebar}
        >
          <Menu className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      <h1 className="min-w-0 truncate text-sm font-semibold leading-none tracking-[-0.02em] text-[var(--foreground)]">
        {title}
      </h1>

      <div className="min-w-0 flex-1" />
    </header>
  );
}
