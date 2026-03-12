import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectConfig } from "./types.js";

interface DispatchPlanItem {
  work_id: string;
  next_action: string;
  reason?: string;
  priority?: number;
}

interface WorkStateEntry {
  work_id: string;
  work_status?: string;
  retry_count?: number;
  retry_budget?: number | null;
  active_session_id?: string | null;
  updated_at?: string;
}

interface ReconciliationEntry {
  work_id: string;
  next_action?: string;
  reason?: string;
  active_session_id?: string | null;
  updated_at?: string;
}

interface RepoPolicySnapshot {
  dispatchPlan: DispatchPlanItem[];
  workStateStore: WorkStateEntry[];
  reconciliationState: ReconciliationEntry[];
  workStateStorePath: string;
}

interface GuardResolution {
  workId: string;
}

interface TerminationPolicy {
  workId: string;
  workStatus: string;
  preserveWorkspace: boolean;
  allowCleanup: boolean;
}

export interface WorkspaceLifecyclePolicy {
  preserveWorkspace: boolean;
  destroyWorkspace: boolean;
}

function getHarnessRoot(project: ProjectConfig): string {
  return resolve(project.path, "..");
}

function getIndexesDir(project: ProjectConfig): string {
  return join(getHarnessRoot(project), "project-os", "indexes");
}

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeJsonArray(path: string, payload: unknown[]): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function loadRepoPolicy(project: ProjectConfig): RepoPolicySnapshot {
  const indexesDir = getIndexesDir(project);
  return {
    dispatchPlan: readJsonArray<DispatchPlanItem>(join(indexesDir, "dispatch_plan.json")),
    workStateStore: readJsonArray<WorkStateEntry>(join(indexesDir, "work_state_store.json")),
    reconciliationState: readJsonArray<ReconciliationEntry>(
      join(indexesDir, "reconciliation_state.json"),
    ),
    workStateStorePath: join(indexesDir, "work_state_store.json"),
  };
}

function findReconciliationEntry(
  reconciliationState: ReconciliationEntry[],
  workId: string | undefined,
  sessionId: string,
): ReconciliationEntry | undefined {
  return reconciliationState.find(
    (entry) =>
      entry.active_session_id === sessionId || (workId !== undefined && entry.work_id === workId),
  );
}

function findWorkEntry(
  workStateStore: WorkStateEntry[],
  sessionId: string,
  issueId: string | undefined,
): WorkStateEntry | undefined {
  return workStateStore.find(
    (entry) =>
      entry.active_session_id === sessionId || (issueId !== undefined && entry.work_id === issueId),
  );
}

function upsertWorkState(
  project: ProjectConfig,
  workId: string,
  mutate: (entry: WorkStateEntry | undefined) => WorkStateEntry,
): void {
  const policy = loadRepoPolicy(project);
  const index = policy.workStateStore.findIndex((entry) => entry.work_id === workId);
  const next = mutate(index >= 0 ? policy.workStateStore[index] : undefined);

  if (index >= 0) {
    policy.workStateStore[index] = next;
  } else {
    policy.workStateStore.push(next);
  }

  writeJsonArray(policy.workStateStorePath, policy.workStateStore);
}

export function assertSpawnAllowed(
  project: ProjectConfig,
  issueId: string | undefined,
): GuardResolution | null {
  if (!issueId) return null;

  const { dispatchPlan } = loadRepoPolicy(project);
  const plan = dispatchPlan.find((entry) => entry.work_id === issueId);
  if (!plan) return null;

  if (!new Set(["dispatch", "retry"]).has(plan.next_action)) {
    const reason = plan.reason ? ` (${plan.reason})` : "";
    throw new Error(
      `Spawn blocked by repo policy for ${issueId}: expected dispatch or retry, got ${plan.next_action}${reason}`,
    );
  }

  return { workId: issueId };
}

export function assertRestoreAllowed(
  project: ProjectConfig,
  sessionId: string,
  issueId: string | undefined,
): GuardResolution | null {
  const { workStateStore, reconciliationState } = loadRepoPolicy(project);
  const workEntry = findWorkEntry(workStateStore, sessionId, issueId);
  const workId = workEntry?.work_id ?? issueId;
  const reconcile = findReconciliationEntry(reconciliationState, workId, sessionId);

  if (!workEntry && !reconcile) return null;
  if (workId === undefined) return null;

  if (reconcile?.next_action && reconcile.next_action !== "reconcile_session") {
    const reason = reconcile.reason ? ` (${reconcile.reason})` : "";
    throw new Error(
      `Restore blocked by repo policy for ${workId}: expected reconcile_session, got ${reconcile.next_action}${reason}`,
    );
  }

  return { workId };
}

export function persistActiveSession(
  project: ProjectConfig,
  workId: string,
  sessionId: string,
  workStatus = "dispatched",
): void {
  upsertWorkState(project, workId, (existing) => ({
    work_id: workId,
    work_status: workStatus,
    retry_count: existing?.retry_count ?? 0,
    retry_budget: existing?.retry_budget ?? null,
    active_session_id: sessionId,
    updated_at: new Date().toISOString(),
  }));
}

export function assertSendAllowed(
  project: ProjectConfig,
  sessionId: string,
  issueId: string | undefined,
): GuardResolution | null {
  const { workStateStore, reconciliationState } = loadRepoPolicy(project);
  const workEntry = findWorkEntry(workStateStore, sessionId, issueId);
  const workId = workEntry?.work_id ?? issueId;
  const reconcile = findReconciliationEntry(reconciliationState, workId, sessionId);

  if (!workEntry && !reconcile) return null;
  if (workId === undefined) return null;

  if (new Set(["done", "killed", "abandoned"]).has(workEntry?.work_status ?? "")) {
    throw new Error(`Send blocked by repo policy for ${workId}: work is terminal`);
  }
  if (reconcile?.next_action === "terminal") {
    throw new Error(`Send blocked by repo policy for ${workId}: reconciliation is terminal`);
  }

  return { workId };
}

export function resolveTerminationPolicy(
  project: ProjectConfig,
  sessionId: string,
  issueId: string | undefined,
): TerminationPolicy | null {
  const { workStateStore, reconciliationState } = loadRepoPolicy(project);
  const workEntry = findWorkEntry(workStateStore, sessionId, issueId);
  const workId = workEntry?.work_id ?? issueId;
  const reconcile = findReconciliationEntry(reconciliationState, workId, sessionId);

  if (!workEntry && !reconcile) return null;
  if (workId === undefined) return null;

  const workStatus = workEntry?.work_status ?? "needs_input";
  if (new Set(["done", "killed", "abandoned"]).has(workStatus)) {
    return { workId, workStatus, preserveWorkspace: false, allowCleanup: true };
  }
  if (reconcile?.next_action === "terminal") {
    return { workId, workStatus: "abandoned", preserveWorkspace: false, allowCleanup: true };
  }

  return {
    workId,
    workStatus: workStatus === "review" ? "review" : "needs_input",
    preserveWorkspace: true,
    allowCleanup: false,
  };
}

export function resolveWorkspaceLifecyclePolicy(
  project: ProjectConfig,
  sessionId: string,
  issueId: string | undefined,
): WorkspaceLifecyclePolicy | null {
  const termination = resolveTerminationPolicy(project, sessionId, issueId);
  if (!termination) return null;
  return {
    preserveWorkspace: termination.preserveWorkspace,
    destroyWorkspace: !termination.preserveWorkspace,
  };
}

export function persistTerminalWorkState(
  project: ProjectConfig,
  sessionId: string,
  issueId: string | undefined,
  fallbackStatus = "killed",
): GuardResolution | null {
  const policy = resolveTerminationPolicy(project, sessionId, issueId);
  const workId = policy?.workId ?? issueId;
  if (!workId) return null;

  upsertWorkState(project, workId, (existing) => ({
    work_id: workId,
    work_status: policy?.workStatus ?? fallbackStatus,
    retry_count: existing?.retry_count ?? 0,
    retry_budget: existing?.retry_budget ?? null,
    active_session_id: null,
    updated_at: new Date().toISOString(),
  }));

  return { workId };
}
