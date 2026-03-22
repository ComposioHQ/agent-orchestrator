import type { DashboardOrchestratorLink } from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";

export type SpawnButtonVariant = "default" | "compact" | "inline" | "sidebar";

interface SpawnOrchestratorButtonProps {
  project: ProjectInfo;
  orchestrator: DashboardOrchestratorLink | null;
  onSpawnOrchestrator: (project: ProjectInfo) => Promise<void>;
  isSpawning: boolean;
  error?: string;
  variant?: SpawnButtonVariant;
}

const variantClasses: Record<SpawnButtonVariant, { button: string; link: string }> = {
  default: {
    button:
      "orchestrator-btn rounded-[var(--radius-lg)] px-4 py-2 text-[12px] font-semibold disabled:cursor-wait disabled:opacity-70",
    link: "orchestrator-btn flex items-center gap-2 rounded-[var(--radius-lg)] px-4 py-2 text-[12px] font-semibold hover:no-underline",
  },
  compact: {
    button:
      "orchestrator-btn rounded-[var(--radius-lg)] px-3 py-1.5 text-[11px] font-semibold disabled:cursor-wait disabled:opacity-70",
    link: "orchestrator-btn flex items-center gap-2 rounded-[var(--radius-lg)] px-3 py-1.5 text-[11px] font-semibold hover:no-underline",
  },
  inline: {
    button:
      "orchestrator-btn rounded-[var(--radius-md)] px-2.5 py-1 text-[11px] font-medium disabled:cursor-wait disabled:opacity-70",
    link: "orchestrator-btn flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1 text-[11px] font-medium hover:no-underline",
  },
  sidebar: {
    button:
      "shrink-0 px-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-text-primary)] group-hover:opacity-100 disabled:cursor-wait disabled:opacity-50",
    link: "shrink-0 px-1",
  },
};

export function SpawnOrchestratorButton({
  project,
  orchestrator,
  onSpawnOrchestrator,
  isSpawning,
  error,
  variant = "default",
}: SpawnOrchestratorButtonProps) {
  const classes = variantClasses[variant];

  const isSidebar = variant === "sidebar";

  return (
    <div className={isSidebar ? "inline-flex" : "flex flex-col items-end gap-1.5"}>
      {orchestrator ? (
        <a
          href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
          title={isSidebar ? "Orchestrator running" : undefined}
          className={classes.link}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
          {!isSidebar && (
            <>
              orchestrator
              <svg className="h-3 w-3 opacity-70" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </>
          )}
        </a>
      ) : (
        <button
          type="button"
          aria-label={isSidebar ? `Spawn orchestrator for ${project.name}` : undefined}
          onClick={() => void onSpawnOrchestrator(project)}
          disabled={isSpawning}
          className={classes.button}
        >
          {isSidebar ? (
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          ) : (
            isSpawning ? "Spawning..." : "Spawn Orchestrator"
          )}
        </button>
      )}

      {!isSidebar && error ? (
        <span className="text-[11px] text-[var(--color-status-error)]">{error}</span>
      ) : null}
    </div>
  );
}
