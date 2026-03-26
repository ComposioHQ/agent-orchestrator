"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import type { DashboardSession } from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "ao:web:sidebar-collapsed";

export default function WithSidebarLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<DashboardSession[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    let cancelled = false;

    async function loadSidebarData(): Promise<void> {
      try {
        const [projectsRes, sessionsRes] = await Promise.all([
          fetch("/api/projects"),
          fetch("/api/sessions?active=true"),
        ]);

        if (!cancelled && projectsRes.ok) {
          const data = (await projectsRes.json()) as { projects?: ProjectInfo[] };
          setProjects(data.projects ?? []);
        }

        if (!cancelled && sessionsRes.ok) {
          const data = (await sessionsRes.json()) as { sessions?: DashboardSession[] };
          setSessions(data.sessions ?? []);
        }
      } catch {
        if (!cancelled) {
          setProjects([]);
          setSessions([]);
        }
      }
    }

    void loadSidebarData();
    const intervalId = setInterval(loadSidebarData, 10_000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const routeSessionId = useMemo(() => {
    const matchShort = pathname.match(/^\/s\/([^/]+)$/);
    if (matchShort?.[1]) return decodeURIComponent(matchShort[1]);
    const matchLong = pathname.match(/^\/sessions\/([^/]+)$/);
    if (matchLong?.[1]) return decodeURIComponent(matchLong[1]);
    return undefined;
  }, [pathname]);

  const searchSessionId = searchParams.get("session") ?? undefined;
  const activeSessionId = routeSessionId ?? searchSessionId;

  const activeProjectId = useMemo(() => {
    const fromQuery = searchParams.get("project");
    if (fromQuery && fromQuery !== "all") return fromQuery;
    if (!routeSessionId) return undefined;
    return sessions.find((session) => session.id === routeSessionId)?.projectId;
  }, [routeSessionId, searchParams, sessions]);

  return (
    <div className="dashboard-shell flex h-screen">
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId={activeProjectId}
        activeSessionId={activeSessionId}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
