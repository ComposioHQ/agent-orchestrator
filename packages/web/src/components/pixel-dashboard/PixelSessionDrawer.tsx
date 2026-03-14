import type { DashboardSession } from "@/lib/types";
import type { ProjectOverview } from "../Dashboard";
import { PixelSessionDrawerContent } from "./pixel-session-drawer";

interface PixelSessionDrawerProps {
  allProjectsView: boolean;
  onClose: () => void;
  projectOverview?: ProjectOverview | null;
  selectedSession: DashboardSession | null;
}

export function PixelSessionDrawer({
  allProjectsView,
  onClose,
  projectOverview,
  selectedSession,
}: PixelSessionDrawerProps) {
  return (
    <aside
      className="rounded-[20px] border border-[var(--color-border-default)] bg-[linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.94))] p-4 shadow-[0_18px_50px_rgba(3,8,20,0.18)] xl:sticky xl:top-0"
      data-testid="pixel-session-drawer"
    >
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-[rgba(148,163,184,0.14)] pb-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">
            Inspection drawer
          </div>
          <h3 className="mt-1 text-[16px] font-semibold text-[var(--color-text-primary)]">
            {selectedSession ? "Selected session" : "Choose a session"}
          </h3>
        </div>
        {selectedSession ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-[9px] border border-[rgba(148,163,184,0.24)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)]"
          >
            Clear
          </button>
        ) : null}
      </div>

      {selectedSession ? (
        <PixelSessionDrawerContent
          allProjectsView={allProjectsView}
          projectOverview={projectOverview}
          selectedSession={selectedSession}
        />
      ) : (
        <div className="rounded-[14px] border border-dashed border-[rgba(148,163,184,0.2)] bg-[rgba(15,23,42,0.42)] px-4 py-6 text-[13px] leading-6 text-[var(--color-text-muted)]">
          Select a worker in the world to inspect its summary, branch, issue context, recent state,
          and PR readiness without leaving the scene.
        </div>
      )}
    </aside>
  );
}
