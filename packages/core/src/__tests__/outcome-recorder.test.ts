import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { OutcomeRecorder } from "../outcome-recorder.js";
import type { RecordedOutcome } from "../types.js";

function makeOutcome(overrides: Partial<RecordedOutcome> = {}): RecordedOutcome {
  return {
    sessionId: randomUUID(),
    projectId: "proj-1",
    trigger: "ci-failed",
    action: "fix-lint",
    strategy: "retry-with-fix",
    success: true,
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("OutcomeRecorder", () => {
  let testDir: string;
  let recorder: OutcomeRecorder;

  beforeEach(() => {
    testDir = join(tmpdir(), `outcome-recorder-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    recorder = new OutcomeRecorder({ storagePath: join(testDir, "outcomes.jsonl") });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("record appends outcome to file", () => {
    const outcome = makeOutcome();
    recorder.record(outcome);

    const content = readFileSync(join(testDir, "outcomes.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.sessionId).toBe(outcome.sessionId);
  });

  it("record creates file if it doesn't exist", () => {
    const nestedPath = join(testDir, "nested", "dir", "outcomes.jsonl");
    const rec = new OutcomeRecorder({ storagePath: nestedPath });

    rec.record(makeOutcome());
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("multiple record calls produce valid JSONL", () => {
    recorder.record(makeOutcome({ action: "a1" }));
    recorder.record(makeOutcome({ action: "a2" }));
    recorder.record(makeOutcome({ action: "a3" }));

    const content = readFileSync(join(testDir, "outcomes.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    lines.forEach((line) => {
      expect(() => JSON.parse(line)).not.toThrow();
    });
  });

  it("query with no filters returns all outcomes", () => {
    recorder.record(makeOutcome());
    recorder.record(makeOutcome());
    recorder.record(makeOutcome());

    const results = recorder.query({});
    expect(results).toHaveLength(3);
  });

  it("query by trigger filters correctly", () => {
    recorder.record(makeOutcome({ trigger: "ci-failed" }));
    recorder.record(makeOutcome({ trigger: "pr-created" }));
    recorder.record(makeOutcome({ trigger: "ci-failed" }));

    const results = recorder.query({ trigger: "ci-failed" });
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.trigger).toBe("ci-failed"));
  });

  it("query by action filters correctly", () => {
    recorder.record(makeOutcome({ action: "fix-lint" }));
    recorder.record(makeOutcome({ action: "fix-test" }));
    recorder.record(makeOutcome({ action: "fix-lint" }));

    const results = recorder.query({ action: "fix-lint" });
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.action).toBe("fix-lint"));
  });

  it("query by projectId filters correctly", () => {
    recorder.record(makeOutcome({ projectId: "proj-1" }));
    recorder.record(makeOutcome({ projectId: "proj-2" }));
    recorder.record(makeOutcome({ projectId: "proj-1" }));

    const results = recorder.query({ projectId: "proj-1" });
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.projectId).toBe("proj-1"));
  });

  it("getWinRate groups by strategy, not trigger", () => {
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: false }));

    const rate = recorder.getWinRate("retry-with-fix", "fix-lint");
    expect(rate).toBeCloseTo(2 / 3);
  });

  it("getWinRate returns 0 for unknown combo", () => {
    const rate = recorder.getWinRate("unknown-strategy", "unknown-action");
    expect(rate).toBe(0);
  });

  it("getTopStrategies ranks by win rate descending, grouped by strategy", () => {
    // fix-lint: 2/3 wins = 0.667
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: false }));

    // fix-test: 3/3 wins = 1.0
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-test", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-test", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-test", success: true }));

    const strategies = recorder.getTopStrategies("retry-with-fix");
    expect(strategies[0].action).toBe("fix-test");
    expect(strategies[0].winRate).toBe(1.0);
    expect(strategies[1].action).toBe("fix-lint");
    expect(strategies[1].winRate).toBeCloseTo(2 / 3);
  });

  it("getTopStrategies respects limit parameter", () => {
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "a1", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "a2", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "a3", success: true }));

    const strategies = recorder.getTopStrategies("retry-with-fix", 2);
    expect(strategies).toHaveLength(2);
  });

  it("clear empties the file", () => {
    recorder.record(makeOutcome());
    recorder.record(makeOutcome());

    recorder.clear();

    const results = recorder.query({});
    expect(results).toHaveLength(0);

    const filePath = join(testDir, "outcomes.jsonl");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toBe("");
  });

  it("getWinRate isolates different strategies for the same trigger", () => {
    recorder.record(makeOutcome({ trigger: "ci-failed", strategy: "retry-with-fix", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ trigger: "ci-failed", strategy: "retry-with-fix", action: "fix-lint", success: false }));
    recorder.record(makeOutcome({ trigger: "ci-failed", strategy: "escalate-to-human", action: "fix-lint", success: false }));
    recorder.record(makeOutcome({ trigger: "ci-failed", strategy: "escalate-to-human", action: "fix-lint", success: false }));

    expect(recorder.getWinRate("retry-with-fix", "fix-lint")).toBeCloseTo(0.5);
    expect(recorder.getWinRate("escalate-to-human", "fix-lint")).toBe(0);
  });

  it("getTopStrategies only returns actions for the requested strategy", () => {
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: true }));
    recorder.record(makeOutcome({ strategy: "escalate-to-human", action: "notify-team", success: true }));

    const retryStrategies = recorder.getTopStrategies("retry-with-fix");
    expect(retryStrategies).toHaveLength(1);
    expect(retryStrategies[0].action).toBe("fix-lint");

    const escalateStrategies = recorder.getTopStrategies("escalate-to-human");
    expect(escalateStrategies).toHaveLength(1);
    expect(escalateStrategies[0].action).toBe("notify-team");
  });

  it("readAll skips malformed JSONL lines without crashing", () => {
    const filePath = join(testDir, "outcomes.jsonl");
    recorder.record(makeOutcome({ action: "valid-1" }));
    appendFileSync(filePath, "THIS IS NOT JSON\n", "utf-8");
    appendFileSync(filePath, "{broken json\n", "utf-8");
    recorder.record(makeOutcome({ action: "valid-2" }));

    const results = recorder.query({});
    expect(results).toHaveLength(2);
    expect(results[0].action).toBe("valid-1");
    expect(results[1].action).toBe("valid-2");
  });

  it("getWinRate handles malformed JSONL lines gracefully", () => {
    const filePath = join(testDir, "outcomes.jsonl");
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: true }));
    appendFileSync(filePath, "CORRUPT LINE\n", "utf-8");
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: false }));

    const rate = recorder.getWinRate("retry-with-fix", "fix-lint");
    expect(rate).toBeCloseTo(0.5);
  });

  it("getTopStrategies handles malformed JSONL lines gracefully", () => {
    const filePath = join(testDir, "outcomes.jsonl");
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", success: true }));
    appendFileSync(filePath, "NOT VALID JSON\n", "utf-8");

    const strategies = recorder.getTopStrategies("retry-with-fix");
    expect(strategies).toHaveLength(1);
    expect(strategies[0].action).toBe("fix-lint");
  });

  it("query filters by errorClass", () => {
    recorder.record(makeOutcome({ trigger: "ci-failed", errorClass: "lint-error" }));
    recorder.record(makeOutcome({ trigger: "ci-failed", errorClass: "test-failure" }));
    recorder.record(makeOutcome({ trigger: "ci-failed", errorClass: "lint-error" }));

    const results = recorder.query({ errorClass: "lint-error" });
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r.errorClass).toBe("lint-error"));
  });

  it("getWinRate filters by errorClass to avoid cross-contamination", () => {
    // lint-error: 1/1 = 100%
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", errorClass: "lint-error", success: true }));
    // test-failure: 0/1 = 0%
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", errorClass: "test-failure", success: false }));

    expect(recorder.getWinRate("retry-with-fix", "fix-lint", "lint-error")).toBe(1.0);
    expect(recorder.getWinRate("retry-with-fix", "fix-lint", "test-failure")).toBe(0);
    // Without errorClass filter, blended rate
    expect(recorder.getWinRate("retry-with-fix", "fix-lint")).toBeCloseTo(0.5);
  });

  it("getTopStrategies filters by errorClass", () => {
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-lint", errorClass: "lint-error", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-test", errorClass: "test-failure", success: true }));
    recorder.record(makeOutcome({ strategy: "retry-with-fix", action: "fix-build", errorClass: "lint-error", success: false }));

    const lintStrategies = recorder.getTopStrategies("retry-with-fix", undefined, "lint-error");
    expect(lintStrategies).toHaveLength(2);
    expect(lintStrategies[0].action).toBe("fix-lint");

    const testStrategies = recorder.getTopStrategies("retry-with-fix", undefined, "test-failure");
    expect(testStrategies).toHaveLength(1);
    expect(testStrategies[0].action).toBe("fix-test");
  });
});
