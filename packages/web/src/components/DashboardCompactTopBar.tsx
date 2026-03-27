"use client";

import type { ReactNode } from "react";
import type { ProjectInfo } from "@/lib/project-name";
import { useSidebarContext } from "@/components/workspace/SidebarContext";
import "@/components/workspace/compact-top-bar.css";

interface DashboardCompactTopBarProps {
  title: string;
  subtitle: string;
  projects: ProjectInfo[];
  children: ReactNode;
}

export function DashboardCompactTopBar({ title, subtitle, projects, children }: DashboardCompactTopBarProps) {
  const sidebar = useSidebarContext();
  const showSidebarToggle = projects.length > 1 && Boolean(sidebar?.onToggleSidebar);
  const onToggle = sidebar?.onToggleSidebar;

  return (
    <div className="compact-top-bar compact-top-bar--dashboard">
      <div className="compact-top-bar__left">
        {showSidebarToggle && onToggle && (
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
          <div className="compact-top-bar__row1">
            <span className="dashboard-compact-top-bar__title">{title}</span>
          </div>
          <p className="dashboard-compact-top-bar__subtitle">{subtitle}</p>
        </div>
      </div>
      <div className="compact-top-bar__right dashboard-compact-top-bar__actions">{children}</div>
    </div>
  );
}
