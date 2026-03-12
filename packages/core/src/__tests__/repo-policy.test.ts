import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  assertRestoreAllowed,
  assertSendAllowed,
  assertSpawnAllowed,
  persistActiveSession,
  persistTerminalWorkState,
  resolveTerminationPolicy,
  resolveWorkspaceLifecyclePolicy,
} from "../repo-policy.js";
import type { ProjectConfig } from "../types.js";

function makeProject(root: string): ProjectConfig {
  const projectPath = join(root, "agent-orchestrator");
  mkdirSync(projectPath, { recursive: true });
  return {
    name: "Agent Orchestrator",
    repo: "org/agent-orchestrator",
    path: projectPath,
    defaultBranch: "main",
    sessionPrefix: "ao",
  };
}

function writeIndex(root: string, name: string, payload: unknown): void {
  const indexDir = join(root, "project-os", "indexes");
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, name), JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

describe("repo policy guards", () => {
  it("allows spawn only for dispatch or retry actions", () => {
    const root = join(tmpdir(), `ao-repo-policy-${randomUUID()}`);
    const project = makeProject(root);
    writeIndex(root, "dispatch_plan.json", [
      { work_id: "TKT-1", next_action: "dispatch", reason: "eligible" },
      { work_id: "TKT-2", next_action: "retry", reason: "retryable" },
      { work_id: "TKT-3", next_action: "escalate", reason: "blocked" },
    ]);

    expect(assertSpawnAllowed(project, "TKT-1")).toEqual({ workId: "TKT-1" });
    expect(assertSpawnAllowed(project, "TKT-2")).toEqual({ workId: "TKT-2" });
    expect(() => assertSpawnAllowed(project, "TKT-3")).toThrow("Spawn blocked by repo policy");
  });

  it("allows restore only for reconcile_session actions", () => {
    const root = join(tmpdir(), `ao-repo-policy-${randomUUID()}`);
    const project = makeProject(root);
    writeIndex(root, "work_state_store.json", [
      { work_id: "TKT-1", active_session_id: "ao-1", work_status: "dispatched" },
    ]);
    writeIndex(root, "reconciliation_state.json", [
      {
        work_id: "TKT-1",
        active_session_id: "ao-1",
        next_action: "reconcile_session",
        reason: "missing active run snapshot",
      },
    ]);

    expect(assertRestoreAllowed(project, "ao-1", "TKT-1")).toEqual({ workId: "TKT-1" });

    writeIndex(root, "reconciliation_state.json", [
      {
        work_id: "TKT-1",
        active_session_id: "ao-1",
        next_action: "operator_review",
        reason: "awaiting review",
      },
    ]);

    expect(() => assertRestoreAllowed(project, "ao-1", "TKT-1")).toThrow(
      "Restore blocked by repo policy",
    );
  });

  it("persists active session into the work state store", () => {
    const root = join(tmpdir(), `ao-repo-policy-${randomUUID()}`);
    const project = makeProject(root);
    writeIndex(root, "work_state_store.json", [
      {
        work_id: "TKT-1",
        work_status: "queued",
        retry_count: 1,
        retry_budget: 2,
      },
    ]);

    persistActiveSession(project, "TKT-1", "ao-9");

    const persisted = JSON.parse(
      readFileSync(join(root, "project-os", "indexes", "work_state_store.json"), "utf-8"),
    ) as Array<Record<string, unknown>>;

    expect(persisted).toEqual([
      expect.objectContaining({
        work_id: "TKT-1",
        work_status: "dispatched",
        retry_count: 1,
        retry_budget: 2,
        active_session_id: "ao-9",
      }),
    ]);
  });

  it("derives non-terminal termination policy as preserve-and-reconcile", () => {
    const root = join(tmpdir(), `ao-repo-policy-${randomUUID()}`);
    const project = makeProject(root);
    writeIndex(root, "work_state_store.json", [
      { work_id: "TKT-1", active_session_id: "ao-1", work_status: "dispatched" },
    ]);
    writeIndex(root, "reconciliation_state.json", [
      {
        work_id: "TKT-1",
        active_session_id: "ao-1",
        next_action: "reconcile_session",
      },
    ]);

    expect(resolveTerminationPolicy(project, "ao-1", "TKT-1")).toEqual({
      workId: "TKT-1",
      workStatus: "needs_input",
      preserveWorkspace: true,
      allowCleanup: false,
    });
  });

  it("blocks send for terminal work and clears active session on terminal persist", () => {
    const root = join(tmpdir(), `ao-repo-policy-${randomUUID()}`);
    const project = makeProject(root);
    writeIndex(root, "work_state_store.json", [
      { work_id: "TKT-1", active_session_id: "ao-1", work_status: "done" },
    ]);

    expect(() => assertSendAllowed(project, "ao-1", "TKT-1")).toThrow(
      "Send blocked by repo policy",
    );

    persistTerminalWorkState(project, "ao-1", "TKT-1", "done");

    const persisted = JSON.parse(
      readFileSync(join(root, "project-os", "indexes", "work_state_store.json"), "utf-8"),
    ) as Array<Record<string, unknown>>;
    expect(persisted).toEqual([
      expect.objectContaining({
        work_id: "TKT-1",
        work_status: "done",
        active_session_id: null,
      }),
    ]);
  });

  it("derives workspace lifecycle from termination policy", () => {
    const root = join(tmpdir(), `ao-repo-policy-${randomUUID()}`);
    const project = makeProject(root);
    writeIndex(root, "work_state_store.json", [
      { work_id: "TKT-1", active_session_id: "ao-1", work_status: "review" },
      { work_id: "TKT-2", active_session_id: "ao-2", work_status: "done" },
    ]);

    expect(resolveWorkspaceLifecyclePolicy(project, "ao-1", "TKT-1")).toEqual({
      preserveWorkspace: true,
      destroyWorkspace: false,
    });
    expect(resolveWorkspaceLifecyclePolicy(project, "ao-2", "TKT-2")).toEqual({
      preserveWorkspace: false,
      destroyWorkspace: true,
    });
  });
});
