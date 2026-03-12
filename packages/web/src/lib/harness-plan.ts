import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OrchestratorConfig, ProjectConfig } from "@composio/ao-core";
import type {
  DispatchPlanItem,
  HarnessSnapshot,
  ReconciliationItem,
  ScoreSummaryItem,
  SessionHarnessContext,
  WorkStateItem,
} from "./types";

function resolveProjectRoot(project: ProjectConfig | undefined): string | null {
  if (!project?.path) return null;
  return dirname(project.path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function getIndexesDir(config: OrchestratorConfig): string | null {
  const firstProjectKey = Object.keys(config.projects)[0];
  const project = firstProjectKey ? config.projects[firstProjectKey] : undefined;
  const projectRoot = resolveProjectRoot(project);
  if (!projectRoot) return null;
  return join(projectRoot, "project-os", "indexes");
}

async function readJsonArray<T>(
  path: string,
  predicate: (value: unknown) => value is T,
): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(predicate);
  } catch {
    return [];
  }
}

export async function loadHarnessSnapshot(config: OrchestratorConfig): Promise<HarnessSnapshot> {
  const indexesDir = getIndexesDir(config);
  if (!indexesDir) {
    return {
      dispatchPlan: [],
      workState: [],
      reconciliationState: [],
      scoreSummaryByTicket: [],
      needsRescore: [],
    };
  }

  const [dispatchPlan, workState, reconciliationState, scoreSummaryByTicket, needsRescore] =
    await Promise.all([
    readJsonArray(join(indexesDir, "dispatch_plan.json"), isDispatchPlanItem),
    readJsonArray(join(indexesDir, "work_state_store.json"), isWorkStateItem),
    readJsonArray(join(indexesDir, "reconciliation_state.json"), isReconciliationItem),
    readJsonArray(join(indexesDir, "score_summary_by_ticket.json"), isScoreSummaryItem),
    readJsonArray(join(indexesDir, "needs_rescore.json"), isScoreSummaryItem),
  ]);

  return { dispatchPlan, workState, reconciliationState, scoreSummaryByTicket, needsRescore };
}

export async function loadDispatchPlan(config: OrchestratorConfig): Promise<DispatchPlanItem[]> {
  const snapshot = await loadHarnessSnapshot(config);
  return snapshot.dispatchPlan;
}

export function resolveSessionHarnessContext(
  snapshot: HarnessSnapshot,
  sessionId: string,
  issueId: string | null | undefined,
): SessionHarnessContext | null {
  const workState = snapshot.workState.find(
    (entry) =>
      entry.active_session_id === sessionId || (issueId !== undefined && issueId !== null && entry.work_id === issueId),
  );
  const workId = workState?.work_id ?? issueId ?? null;
  if (!workId) return null;

  const reconciliation =
    snapshot.reconciliationState.find(
      (entry) => entry.active_session_id === sessionId || entry.work_id === workId,
    ) ?? null;
  const dispatchPlan =
    snapshot.dispatchPlan.find((entry) => entry.work_id === workId) ?? null;

  return {
    workId,
    workState: workState ?? null,
    reconciliation,
    dispatchPlan,
  };
}

function isDispatchPlanItem(value: unknown): value is DispatchPlanItem {
  if (!isObject(value)) return false;
  return (
    typeof value.work_id === "string" &&
    typeof value.work_status === "string" &&
    typeof value.next_action === "string" &&
    typeof value.priority === "number" &&
    typeof value.reason === "string"
  );
}

function isWorkStateItem(value: unknown): value is WorkStateItem {
  if (!isObject(value)) return false;
  return typeof value.work_id === "string" && typeof value.work_status === "string";
}

function isReconciliationItem(value: unknown): value is ReconciliationItem {
  if (!isObject(value)) return false;
  return typeof value.work_id === "string" && typeof value.next_action === "string";
}

function isScoreSummaryItem(value: unknown): value is ScoreSummaryItem {
  if (!isObject(value)) return false;
  return (
    typeof value.subject_id === "string" &&
    typeof value.artifact_id === "string" &&
    typeof value.score_total === "number" &&
    typeof value.score_band === "string" &&
    typeof value.recommended_action === "string" &&
    typeof value.blocking_findings_count === "number"
  );
}
