import {
  isOrchestratorSession,
  type WorkspaceSession,
  type WorkspaceSummary,
} from "../types/workspace";

export type OrchestratorState = "missing" | "stopped" | "running";

/**
 * Derive lifecycle from explicit durable facts only. Older daemon builds may
 * omit isTerminated, so absence must continue to mean "possibly running".
 */
export function orchestratorState(
  session:
    | Pick<WorkspaceSession, "id" | "isTerminated" | "status">
    | null
    | undefined,
): OrchestratorState {
  if (!session?.id) return "missing";
  if (session.isTerminated === true || session.status === "terminated")
    return "stopped";
  return "running";
}

export type OrchestratorLaunchIntent = {
  clean: boolean;
  label: "Start orchestrator" | "Restart orchestrator";
  confirm: boolean;
};

/**
 * Plan the user-visible launch action. A clean replacement is the only real
 * restart and is destructive, so it is always confirmation-gated.
 */
export function orchestratorLaunchIntent(
  state: OrchestratorState,
): OrchestratorLaunchIntent {
  if (state === "running") {
    return { clean: true, label: "Restart orchestrator", confirm: true };
  }
  return { clean: false, label: "Start orchestrator", confirm: false };
}

export type OrchestratorLaunchEffect = "no_op" | "start" | "restart";

/**
 * Model the daemon's SpawnOrchestrator clean flag. clean:false is an
 * idempotent ensure, not a restart: when something is already running it must
 * leave that session alone.
 */
export function orchestratorLaunchEffect(
  state: OrchestratorState,
  clean: boolean,
): OrchestratorLaunchEffect {
  if (state === "running") return clean ? "restart" : "no_op";
  return "start";
}

/** Newest retained orchestrator, including an explicitly stopped one. */
export function latestProjectOrchestrator(
  sessions: WorkspaceSession[],
): WorkspaceSession | undefined {
  const orchestrators = sessions.filter(isOrchestratorSession);
  const running = orchestrators.filter(
    (session) => orchestratorState(session) === "running",
  );
  return (running.length > 0 ? running : orchestrators).reduce<
    WorkspaceSession | undefined
  >((newest, session) => {
    if (!newest) return session;
    const sessionTime = newestKnownTime(session);
    const newestTime = newestKnownTime(newest);
    if (sessionTime !== newestTime)
      return sessionTime > newestTime ? session : newest;
    return session.id > newest.id ? session : newest;
  }, undefined);
}

/**
 * The wire has no parent pointer, so delegation is represented by project
 * membership: every non-orchestrator session in the project is a worker.
 */
export function orchestratorWorkers(
  sessions: WorkspaceSession[],
  projectId: string,
): WorkspaceSession[] {
  return sessions.filter(
    (session) =>
      session.workspaceId === projectId && !isOrchestratorSession(session),
  );
}

/** Resolve legacy session URLs to their stable project orchestrator route. */
export function orchestratorProjectIdForSession(
  workspaces: WorkspaceSummary[],
  sessionId: string,
): string | undefined {
  return workspaces.find((workspace) =>
    workspace.sessions.some(
      (session) => session.id === sessionId && isOrchestratorSession(session),
    ),
  )?.id;
}

function newestKnownTime(session: WorkspaceSession): number {
  return Math.max(timestamp(session.createdAt), timestamp(session.updatedAt));
}

function timestamp(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
