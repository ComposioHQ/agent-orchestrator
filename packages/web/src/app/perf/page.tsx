"use client";

import { PerfDashboard } from "@/components/PerfDashboard";

export default function PerfPage() {
  return (
    <div className="mx-auto max-w-[1100px] px-8 py-8">
      <div className="mb-7 flex items-baseline justify-between">
        <h1 className="text-[22px] font-semibold tracking-tight">
          <a href="/" className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            <span className="text-[#7c8aff]">Agent</span> Orchestrator
          </a>
          <span className="mx-2 text-[var(--color-text-muted)]">/</span>
          Performance
        </h1>
        <div className="flex gap-3">
          <a
            href="/"
            className="rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)]"
          >
            dashboard
          </a>
          <a
            href="/logs"
            className="rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)]"
          >
            logs
          </a>
        </div>
      </div>

      <PerfDashboard />
    </div>
  );
}
