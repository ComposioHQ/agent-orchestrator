"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";

import { ThemeToggle } from "./ThemeToggle";

interface ProjectSidebarFooterProps {
  settingsOpen: boolean;
  settingsPopoverRef: RefObject<HTMLDivElement | null>;
  settingsRef: RefObject<HTMLDivElement | null>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  showDone: boolean;
  showKilled: boolean;
  showSessionId: boolean;
  setShowDone: Dispatch<SetStateAction<boolean>>;
  setShowKilled: Dispatch<SetStateAction<boolean>>;
  setShowSessionId: Dispatch<SetStateAction<boolean>>;
}

export function ProjectSidebarFooter({
  settingsOpen,
  settingsPopoverRef,
  settingsRef,
  setSettingsOpen,
  showDone,
  showKilled,
  showSessionId,
  setShowDone,
  setShowKilled,
  setShowSessionId,
}: ProjectSidebarFooterProps) {
  return (
    <div className="project-sidebar__footer">
      <div className="flex items-center gap-1 border-t border-[var(--color-border-subtle)] px-2 py-2">
        <button
          type="button"
          onClick={() => setShowKilled(!showKilled)}
          className={showKilled ? "project-sidebar__footer-btn project-sidebar__footer-btn--active" : "project-sidebar__footer-btn"}
          aria-pressed={showKilled}
          title={showKilled ? "Hide killed sessions" : "Show killed sessions"}
          aria-label={showKilled ? "Hide killed sessions" : "Show killed sessions"}
        >
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3C7.03 3 3 7.03 3 12c0 3.1 1.5 5.84 3.8 7.55V21h2.4v-1h1.6v1h2.4v-1h1.6v1H17v-1.45A9 9 0 0 0 21 12c0-4.97-4.03-9-9-9z" />
            <circle cx="9" cy="11" r="1.5" fill="currentColor" stroke="none" />
            <circle cx="15" cy="11" r="1.5" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setShowDone(!showDone)}
          className={showDone ? "project-sidebar__footer-btn project-sidebar__footer-btn--active" : "project-sidebar__footer-btn"}
          aria-pressed={showDone}
          title={showDone ? "Hide completed sessions" : "Show completed sessions"}
          aria-label={showDone ? "Hide completed sessions" : "Show completed sessions"}
        >
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </button>
        <div className="flex-1" />
        <div className="project-sidebar__settings-wrap" ref={settingsRef}>
          <button
            type="button"
            onClick={() => setSettingsOpen((value) => !value)}
            className={settingsOpen ? "project-sidebar__footer-btn project-sidebar__footer-btn--active" : "project-sidebar__footer-btn"}
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            title="Sidebar settings"
            aria-label="Sidebar settings"
          >
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          {settingsOpen ? (
            <div
              ref={settingsPopoverRef}
              className="project-sidebar__settings-popover"
              role="dialog"
              aria-label="Sidebar settings"
            >
              <label className="project-sidebar__settings-row">
                <input
                  type="checkbox"
                  checked={showSessionId}
                  onChange={(event) => setShowSessionId(event.target.checked)}
                />
                <span>Show session ID</span>
              </label>
            </div>
          ) : null}
        </div>
        <ThemeToggle className="project-sidebar__theme-toggle" />
      </div>
    </div>
  );
}
