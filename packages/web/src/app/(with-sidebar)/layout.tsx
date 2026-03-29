"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { SidebarContext } from "@/components/workspace/SidebarContext";
import { NewTerminalModal } from "@/components/NewTerminalModal";
import { cn } from "@/lib/cn";
import type { DashboardOrchestratorLink, DashboardSession } from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";
import type { StandaloneTerminal } from "@/lib/standalone-terminals";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "ao:web:sidebar-collapsed";

interface TerminalWithAlive extends StandaloneTerminal {
  alive: boolean;
}

export default function WithSidebarLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [sessions, setSessions] = useState<DashboardSession[]>([]);
  const [orchestrators, setOrchestrators] = useState<DashboardOrchestratorLink[]>([]);
  const [terminals, setTerminals] = useState<TerminalWithAlive[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  });
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [newTerminalModalOpen, setNewTerminalModalOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;

    async function loadSidebarData(): Promise<void> {
      try {
        const [projectsRes, sessionsRes, terminalsRes] = await Promise.all([
          fetch("/api/projects"),
          fetch("/api/sessions"),
          fetch("/api/terminals"),
        ]);

        if (!cancelled && projectsRes.ok) {
          const data = (await projectsRes.json()) as { projects?: ProjectInfo[] };
          setProjects(data.projects ?? []);
        }

        if (!cancelled && sessionsRes.ok) {
          const data = (await sessionsRes.json()) as {
            sessions?: DashboardSession[];
            orchestrators?: DashboardOrchestratorLink[];
          };
          setSessions(data.sessions ?? []);
          setOrchestrators(data.orchestrators ?? []);
        }

        if (!cancelled && terminalsRes.ok) {
          const data = (await terminalsRes.json()) as { terminals?: TerminalWithAlive[] };
          setTerminals(data.terminals ?? []);
        }
      } catch {
        if (!cancelled) {
          setProjects([]);
          setSessions([]);
          setOrchestrators([]);
          setTerminals([]);
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

  const activeTerminalName = useMemo(() => {
    const match = pathname.match(/^\/terminals\/([^/]+)$/);
    if (match?.[1]) return decodeURIComponent(match[1]);
    return undefined;
  }, [pathname]);

  const _toggleMobileSidebar = useCallback(() => {
    setMobileSidebarOpen((v) => !v);
  }, []);

  const toggleSidebar = useCallback(() => {
    const isMobile = typeof window !== "undefined" && window.innerWidth <= 640;
    if (isMobile) {
      setMobileSidebarOpen((v) => !v);
    } else {
      setSidebarCollapsed((v) => !v);
    }
  }, []);

  const sidebarContextValue = useMemo(() => ({
    onToggleSidebar: toggleSidebar,
  }), [toggleSidebar]);

  const removeTerminal = useCallback(async (id: string) => {
    try {
      await fetch(`/api/terminals/${id}`, { method: "DELETE" });
      setTerminals((prev) => prev.filter((t) => t.id !== id));
    } catch {
      // ignore — terminal stays in list
    }
  }, []);

  const terminalCollapsedAbbr = (label: string) => {
    const t = label.trim();
    if (!t) return "—";
    return t.slice(0, 3).toUpperCase();
  };

  const TerminalsSidebarSectionCollapsed = () => (
    <div className="flex w-full shrink-0 flex-col items-center border-t border-[var(--color-border-subtle)] py-2">
      <button
        type="button"
        onClick={() => setNewTerminalModalOpen(true)}
        className="mb-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-dashed border-[var(--color-border-muted)] text-[12px] text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:bg-[var(--color-bg-hover)]"
        title="New terminal"
        aria-label="New terminal"
      >
        +
      </button>
      {terminals.length > 0 ? (
        <div className="project-sidebar__collapsed-sessions w-full">
          {terminals.slice(0, 5).map((terminal) => {
            const isActive = activeTerminalName === terminal.tmuxName;
            const abbr = terminalCollapsedAbbr(terminal.label);
            const aliveBorder =
              terminal.alive ? "var(--color-status-ready)" : "var(--color-text-tertiary)";
            return (
              <button
                key={terminal.id}
                type="button"
                onClick={() => router.push(`/terminals/${encodeURIComponent(terminal.tmuxName)}`)}
                className={cn(
                  "project-sidebar__collapsed-session-btn",
                  isActive && "project-sidebar__collapsed-session-btn--active",
                )}
                style={isActive ? undefined : { borderColor: aliveBorder }}
                title={terminal.label}
                aria-label={terminal.label}
                aria-current={isActive ? "page" : undefined}
              >
                <span className="project-sidebar__session-abbr-first">{abbr[0]}</span>
                <span className="project-sidebar__session-abbr-rest">{abbr.slice(1)}</span>
              </button>
            );
          })}
          {terminals.length > 5 ? (
            <span
              className="project-sidebar__collapsed-more"
              title={`+${terminals.length - 5} more terminals`}
            >
              +{terminals.length - 5}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const TerminalsSidebarSection = () => (
    <div className="flex flex-col border-t border-[var(--color-border-subtle)] px-2 py-3">
      <div className="mb-2 flex items-center justify-between px-2.5">
        <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
          Terminals
        </span>
        <button
          type="button"
          onClick={() => setNewTerminalModalOpen(true)}
          className="flex h-5 w-5 items-center justify-center rounded border border-dashed border-[var(--color-border-muted)] text-[12px] leading-none text-[var(--color-text-tertiary)] hover:text-[var(--color-accent)]"
          title="New terminal"
        >
          +
        </button>
      </div>
      {terminals.length > 0 ? (
        <div className="terminal-sidebar-list space-y-0.5">
          {terminals.map((terminal) => {
            const isActive = activeTerminalName === terminal.tmuxName;
            const aliveIndicator = terminal.alive ? "●" : "○";
            const indicatorColor = terminal.alive
              ? "var(--color-status-ready)"
              : "var(--color-text-tertiary)";

            return (
              <div
                key={terminal.id}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/terminals/${encodeURIComponent(terminal.tmuxName)}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    router.push(`/terminals/${encodeURIComponent(terminal.tmuxName)}`);
                  }
                }}
                className={`project-sidebar__session group flex w-full cursor-pointer items-center gap-2 py-[6px] pl-3 pr-2 text-[11px] transition-colors ${
                  isActive
                    ? "project-sidebar__session--active text-[var(--color-accent)]"
                    : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
                }`}
              >
                <span style={{ color: indicatorColor }}>{aliveIndicator}</span>
                <span className="min-w-0 flex-1 truncate">{terminal.label}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeTerminal(terminal.id);
                  }}
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[13px] leading-none transition-all ${
                    terminal.alive
                      ? "opacity-0 group-hover:opacity-100 text-[var(--color-text-tertiary)] hover:bg-[color-mix(in_srgb,var(--color-status-error)_15%,transparent)] hover:text-[var(--color-status-error)] active:bg-[color-mix(in_srgb,var(--color-status-error)_25%,transparent)]"
                      : "opacity-100 text-[var(--color-text-tertiary)] hover:bg-[color-mix(in_srgb,var(--color-status-error)_15%,transparent)] hover:text-[var(--color-status-error)] active:bg-[color-mix(in_srgb,var(--color-status-error)_25%,transparent)]"
                  }`}
                  title="Remove terminal"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-2.5 py-2 text-[10px] text-[var(--color-text-tertiary)]">
          No terminals
        </div>
      )}
    </div>
  );

  return (
    <SidebarContext.Provider value={sidebarContextValue}>
      <div className="dashboard-shell flex" style={{ height: "100dvh" }}>
        {/* Desktop sidebar — hidden on mobile via CSS */}
        <div className="dashboard-sidebar-desktop">
          <div className="flex h-full flex-col">
            <ProjectSidebar
              projects={projects}
              sessions={sessions}
              orchestrators={orchestrators}
              activeProjectId={activeProjectId}
              activeSessionId={activeSessionId}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
            />
            {sidebarCollapsed ? <TerminalsSidebarSectionCollapsed /> : <TerminalsSidebarSection />}
          </div>
        </div>

        {/* Mobile sidebar overlay */}
        {mobileSidebarOpen && (
          <div className="dashboard-sidebar-overlay" onClick={() => setMobileSidebarOpen(false)}>
            <div className="dashboard-sidebar-mobile" onClick={(e) => e.stopPropagation()}>
              <div className="flex h-full flex-col">
                <ProjectSidebar
                  projects={projects}
                  sessions={sessions}
                  orchestrators={orchestrators}
                  activeProjectId={activeProjectId}
                  activeSessionId={activeSessionId}
                  collapsed={false}
                  onToggleCollapsed={() => setMobileSidebarOpen(false)}
                />
                <TerminalsSidebarSection />
              </div>
            </div>
          </div>
        )}

        <div className="min-w-0 flex-1">{children}</div>

        {/* New Terminal Modal */}
        <NewTerminalModal open={newTerminalModalOpen} onClose={() => setNewTerminalModalOpen(false)} />
      </div>
    </SidebarContext.Provider>
  );
}
