import { describe, expect, it } from "vitest";
import { transitionStagedUpdate, type StagedUpdateJournal, type UpdateCandidate } from "./staged-update-state";

const A: UpdateCandidate = { version: "1.2.0", channel: "latest", operationId: "op-a" };
const B: UpdateCandidate = { version: "1.3.0", channel: "nightly", operationId: "op-b" };
const C: UpdateCandidate = { version: "1.4.0-pr42.1", channel: "pr42", featurePr: 42, operationId: "op-c" };
const stagedA: StagedUpdateJournal = { schemaVersion: 1, state: "native-possibly-staged", staged: A, stagedAt: 100 };

describe("transitionStagedUpdate", () => {
  it.each([
    ["discover replacement", stagedA, { type: "replacement-discovered", replacement: B, at: 200 }, { state: "replacing", staged: A, replacement: B, phase: "checking" }],
    ["advance replacement", { schemaVersion: 1, state: "replacing", staged: A, replacement: B, startedAt: 200, phase: "checking" }, { type: "replacement-phase", operationId: "op-b", phase: "full-fallback" }, { state: "replacing", staged: A, replacement: B, phase: "full-fallback" }],
    ["record replacement failure", { schemaVersion: 1, state: "replacing", staged: A, replacement: B, startedAt: 200, phase: "verifying" }, { type: "replacement-failed", operationId: "op-b", at: 250, message: "checksum" }, { state: "replacement-failed", staged: A, replacement: B, phase: "verifying", message: "checksum" }],
    ["supersede B with C", { schemaVersion: 1, state: "replacing", staged: A, replacement: B, startedAt: 200, phase: "differential" }, { type: "replacement-discovered", replacement: C, at: 300 }, { state: "replacing", staged: A, replacement: C, phase: "checking" }],
    ["keep staged after no update", stagedA, { type: "no-update" }, { state: "native-possibly-staged", staged: A }],
  ] as const)("%s", (_name, state, event, expected) => {
    expect(transitionStagedUpdate(state, event)).toMatchObject(expected);
  });

  it("promotes B only after its native handoff", () => {
    const replacing: StagedUpdateJournal = { schemaVersion: 1, state: "replacing", staged: A, replacement: B, startedAt: 200, phase: "native-handoff" };
    expect(transitionStagedUpdate(replacing, { type: "handoff-succeeded", operationId: "op-b", at: 400 })).toEqual({ schemaVersion: 1, state: "native-possibly-staged", staged: B, stagedAt: 400 });
  });

  it("rejects stale operation events so B cannot overwrite C", () => {
    const replacingC: StagedUpdateJournal = { schemaVersion: 1, state: "replacing", staged: A, replacement: C, startedAt: 300, phase: "checking" };
    expect(() => transitionStagedUpdate(replacingC, { type: "handoff-succeeded", operationId: "op-b", at: 400 })).toThrow(/operation/i);
  });

  it("clears after relaunching the expected replacement", () => {
    const stagedB: StagedUpdateJournal = { schemaVersion: 1, state: "native-possibly-staged", staged: B, stagedAt: 400 };
    expect(transitionStagedUpdate(stagedB, { type: "reconcile-running-version", version: B.version })).toEqual({ schemaVersion: 1, state: "none" });
  });

  it("retains B recovery when relaunch shows A installed", () => {
    const replacing: StagedUpdateJournal = { schemaVersion: 1, state: "replacing", staged: A, replacement: B, startedAt: 200, phase: "verifying" };
    expect(transitionStagedUpdate(replacing, { type: "reconcile-running-version", version: A.version })).toEqual(replacing);
  });

  it("retains a recoverable mismatch after relaunching an unexpected version", () => {
    expect(transitionStagedUpdate(stagedA, { type: "reconcile-running-version", version: "9.9.9" })).toMatchObject({ state: "version-mismatch", staged: A, runningVersion: "9.9.9" });
  });
  it("retains both candidates and the staged clock on a mismatched relaunch", () => {
    const replacing = transitionStagedUpdate(stagedA, { type: "replacement-discovered", replacement: B, at: 200 });
    expect(transitionStagedUpdate(replacing, { type: "reconcile-running-version", version: "0.9.0" })).toMatchObject({ state: "replacing", staged: A, replacement: B, stagedAt: 100, runningVersion: "0.9.0" });
  });

});
