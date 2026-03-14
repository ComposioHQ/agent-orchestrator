"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { updateDashboardHref } from "@/lib/dashboard-route-state";
import type { DashboardView } from "@/lib/types";

interface DashboardModeSwitcherProps {
  view: DashboardView;
}

export function DashboardModeSwitcher({ view }: DashboardModeSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleSwitch = (nextView: DashboardView) => {
    if (nextView === view) return;
    router.push(updateDashboardHref(pathname, searchParams, { view: nextView }));
  };

  return (
    <div
      className="inline-flex items-center rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-1"
      role="tablist"
      aria-label="Dashboard mode"
    >
      {[
        { id: "legacy" as const, label: "Legacy" },
        { id: "pixel" as const, label: "Pixel" },
      ].map((mode) => {
        const active = mode.id === view;
        return (
          <button
            key={mode.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => handleSwitch(mode.id)}
            className={`rounded-[8px] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors ${
              active
                ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
                : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
