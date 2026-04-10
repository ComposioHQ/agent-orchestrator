"use client";

import { useSidebarContext } from "@/components/workspace/SidebarContext";
import "@/components/workspace/compact-top-bar.css";

export default function DashboardLoading() {
  const sidebar = useSidebarContext();
  const onToggle = sidebar?.onToggleSidebar;

  return (
    <div className="dashboard-main h-screen overflow-y-auto">
      {/* Top bar — matches DashboardCompactTopBar layout */}
      <div className="compact-top-bar compact-top-bar--dashboard">
        <div className="compact-top-bar__left">
          {onToggle && (
            <button
              type="button"
              onClick={onToggle}
              className="compact-top-bar__sidebar-toggle"
              title="Toggle sidebar"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2" y1="4" x2="14" y2="4" />
                <line x1="2" y1="8" x2="14" y2="8" />
                <line x1="2" y1="12" x2="14" y2="12" />
              </svg>
            </button>
          )}
          <div className="compact-top-bar__info">
            <div
              className="h-4 w-28 animate-pulse rounded"
              style={{ background: "var(--color-bg-hover)" }}
            />
            <div
              className="h-3 w-48 animate-pulse rounded"
              style={{ background: "var(--color-bg-hover)" }}
            />
          </div>
        </div>
        <div className="compact-top-bar__right dashboard-compact-top-bar__actions">
          <div
            className="h-7 w-20 animate-pulse rounded"
            style={{ background: "var(--color-bg-hover)" }}
          />
        </div>
      </div>

      {/* Kanban columns skeleton */}
      <div className="flex flex-1 gap-4 overflow-x-auto p-6">
        {[1, 2, 3, 4].map((col) => (
          <div key={col} className="flex min-w-[300px] flex-col gap-3">
            <div
              className="h-5 w-20 animate-pulse rounded"
              style={{ background: "var(--color-bg-hover)" }}
            />
            {[1, 2, 3].map((card) => (
              <div
                key={card}
                className="rounded border border-[var(--color-border-subtle)] p-4"
              >
                <div
                  className="mb-3 h-4 w-3/4 animate-pulse rounded"
                  style={{ background: "var(--color-bg-hover)" }}
                />
                <div
                  className="h-3 w-full animate-pulse rounded"
                  style={{ background: "var(--color-bg-hover)" }}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
