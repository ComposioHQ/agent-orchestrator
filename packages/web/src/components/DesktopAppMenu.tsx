"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { MobileBottomNavTab } from "./MobileBottomNav";

interface DesktopAppMenuProps {
  activeTab?: MobileBottomNavTab;
  dashboardHref: string;
  prsHref: string;
  phasesHref: string;
  showOrchestrator?: boolean;
  orchestratorHref?: string | null;
}

export function DesktopAppMenu({
  activeTab,
  dashboardHref,
  prsHref,
  phasesHref,
  showOrchestrator = true,
  orchestratorHref = null,
}: DesktopAppMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const closeMenu = () => setOpen(false);

  return (
    <div ref={containerRef} className="desktop-app-menu">
      <button
        type="button"
        className="dashboard-app-sidebar-toggle"
        onClick={() => setOpen((current) => !current)}
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span className="dashboard-app-sidebar-toggle__label">Menu</span>
      </button>

      {open ? (
        <nav className="desktop-app-menu__panel" aria-label="Desktop navigation">
          <Link
            href={dashboardHref}
            className="desktop-app-menu__item"
            data-active={activeTab === "dashboard" ? "true" : "false"}
            aria-current={activeTab === "dashboard" ? "page" : undefined}
            onClick={closeMenu}
          >
            Dashboard
          </Link>
          <Link
            href={phasesHref}
            className="desktop-app-menu__item"
            data-active={activeTab === "phases" ? "true" : "false"}
            aria-current={activeTab === "phases" ? "page" : undefined}
            onClick={closeMenu}
          >
            Kanban
          </Link>
          <Link
            href={prsHref}
            className="desktop-app-menu__item"
            data-active={activeTab === "prs" ? "true" : "false"}
            aria-current={activeTab === "prs" ? "page" : undefined}
            onClick={closeMenu}
          >
            PRs
          </Link>
          {showOrchestrator ? (
            orchestratorHref ? (
              <Link
                href={orchestratorHref}
                className="desktop-app-menu__item"
                data-active={activeTab === "orchestrator" ? "true" : "false"}
                aria-current={activeTab === "orchestrator" ? "page" : undefined}
                onClick={closeMenu}
              >
                Orchestrator
              </Link>
            ) : (
              <span className="desktop-app-menu__item desktop-app-menu__item--disabled">
                Orchestrator
              </span>
            )
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
