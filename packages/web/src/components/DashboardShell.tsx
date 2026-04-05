"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DashboardSession, PortfolioProjectSummary } from "@/lib/types";
import { useRouter } from "next/navigation";
import { useModal } from "@/hooks/useModal";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { AddProjectModal } from "./AddProjectModal";
import { CloneFromUrlModal } from "./CloneFromUrlModal";
import { UnifiedSidebar } from "./UnifiedSidebar";

interface DashboardShellControls {
  openAddProject: () => void;
  openCloneFromUrl: () => void;
}

interface DashboardShellProps {
  projects: PortfolioProjectSummary[];
  sessions?: DashboardSession[];
  activeProjectId?: string;
  activeSessionId?: string;
  defaultLocation?: string;
  children: ReactNode;
}

const DashboardShellContext = createContext<DashboardShellControls | null>(null);

export function useDashboardShellControls() {
  return useContext(DashboardShellContext);
}

export function DashboardShell({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  defaultLocation = "",
  children,
}: DashboardShellProps) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(228);
  const toggleSidebarCollapse = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const addProjectModal = useModal();
  const cloneModal = useModal();
  const { sessions: liveSessions } = useSessionEvents(sessions ?? []);
  const controls = useMemo<DashboardShellControls>(
    () => ({
      openAddProject: addProjectModal.open,
      openCloneFromUrl: cloneModal.open,
    }),
    [addProjectModal.open, cloneModal.open],
  );

  return (
    <DashboardShellContext.Provider value={controls}>
      <div className="min-h-screen bg-[var(--color-bg-base)] text-[var(--color-text-primary)] lg:flex">
        <UnifiedSidebar
          projects={projects}
          sessions={liveSessions}
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
          onAddProject={addProjectModal.open}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebarCollapse}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
        />

        <div className="min-w-0 flex-1">
          {/* Mobile hamburger — fixed top-right on small screens */}
          <button
            type="button"
            className="fixed right-4 top-4 z-30 inline-flex items-center gap-2 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] shadow-[0_4px_12px_rgba(0,0,0,0.12)] lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            Projects
          </button>
          {children}
        </div>

        <AddProjectModal
          open={addProjectModal.isOpen}
          onClose={addProjectModal.close}
        />
        <CloneFromUrlModal
          open={cloneModal.isOpen}
          onClose={cloneModal.close}
          defaultLocation={defaultLocation}
          onProjectCreated={(projectId) => {
            router.push(`/projects/${encodeURIComponent(projectId)}`);
          }}
        />
      </div>
    </DashboardShellContext.Provider>
  );
}
