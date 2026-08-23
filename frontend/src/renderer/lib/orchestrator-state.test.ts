import { describe, expect, it } from "vitest";
import type { WorkspaceSession } from "../types/workspace";
import {
  latestProjectOrchestrator,
  orchestratorLaunchEffect,
  orchestratorLaunchIntent,
  orchestratorProjectIdForSession,
  orchestratorState,
  orchestratorWorkers,
} from "./orchestrator-state";

function session(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    id: "proj-1-orchestrator",
    workspaceId: "proj-1",
    workspaceName: "Project One",
    title: "Orchestrator",
    provider: "codex",
    kind: "orchestrator",
    status: "working",
    updatedAt: "2026-08-01T00:00:00Z",
    prs: [],
    ...overrides,
  };
}

describe("orchestratorState", () => {
  it("distinguishes missing, explicitly stopped, and running sessions", () => {
    expect(orchestratorState(undefined)).toBe("missing");
    expect(orchestratorState(session({ isTerminated: true }))).toBe("stopped");
    expect(orchestratorState(session({ status: "terminated" }))).toBe(
      "stopped",
    );
    expect(orchestratorState(session())).toBe("running");
  });

  it("does not infer stopped from an omitted termination flag", () => {
    expect(orchestratorState(session({ isTerminated: undefined }))).toBe(
      "running",
    );
  });
});

describe("orchestrator launch semantics", () => {
  it("treats clean:false on a running orchestrator as a no-op, never a restart", () => {
    expect(orchestratorLaunchEffect("running", false)).toBe("no_op");
    expect(orchestratorLaunchEffect("running", false)).not.toBe("restart");
  });

  it("uses clean:true for a real restart and gates it behind confirmation", () => {
    expect(orchestratorLaunchEffect("running", true)).toBe("restart");
    expect(orchestratorLaunchIntent("running")).toEqual({
      clean: true,
      label: "Restart orchestrator",
      confirm: true,
    });
  });

  it("uses the non-destructive ensure when nothing is running", () => {
    for (const state of ["missing", "stopped"] as const) {
      expect(orchestratorLaunchIntent(state)).toEqual({
        clean: false,
        label: "Start orchestrator",
        confirm: false,
      });
      expect(orchestratorLaunchEffect(state, false)).toBe("start");
    }
  });
});

describe("orchestrator relationships", () => {
  it("selects the newest retained orchestrator even when it is stopped", () => {
    const older = session({
      id: "orch-a",
      isTerminated: true,
      updatedAt: "2026-07-01T00:00:00Z",
    });
    const newer = session({
      id: "orch-b",
      isTerminated: true,
      updatedAt: "2026-08-01T00:00:00Z",
    });
    expect(latestProjectOrchestrator([older, newer])?.id).toBe("orch-b");
  });

  it("prefers a running orchestrator over a newer stopped record", () => {
    const running = session({
      id: "orch-running",
      updatedAt: "2026-07-01T00:00:00Z",
    });
    const stopped = session({
      id: "orch-stopped",
      isTerminated: true,
      updatedAt: "2026-08-01T00:00:00Z",
    });
    expect(latestProjectOrchestrator([running, stopped])?.id).toBe(
      "orch-running",
    );
  });

  it("lists project workers without counting orchestrators or another project", () => {
    const worker = session({ id: "worker-a", kind: "worker" });
    const other = session({
      id: "worker-b",
      kind: "worker",
      workspaceId: "proj-2",
    });
    expect(
      orchestratorWorkers([session(), worker, other], "proj-1").map(
        ({ id }) => id,
      ),
    ).toEqual(["worker-a"]);
  });

  it("resolves only orchestrator session ids to the stable project route", () => {
    const project = {
      id: "proj-1",
      name: "Project One",
      path: "/repo/project-one",
      sessions: [session(), session({ id: "worker-1", kind: "worker" })],
    };
    expect(
      orchestratorProjectIdForSession([project], "proj-1-orchestrator"),
    ).toBe("proj-1");
    expect(
      orchestratorProjectIdForSession([project], "worker-1"),
    ).toBeUndefined();
  });
});
