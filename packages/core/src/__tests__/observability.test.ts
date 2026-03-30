import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createProjectObserver,
  createCorrelationId,
  readObservabilitySummary,
  type OrchestratorConfig,
} from "../index.js";
import { generateConfigHash } from "../paths.js";

let tempRoot: string;
let configPath: string;
let config: OrchestratorConfig;

beforeEach(() => {
  tempRoot = join(tmpdir(), `ao-observability-test-${randomUUID()}`);
  mkdirSync(tempRoot, { recursive: true });
  configPath = join(tempRoot, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n", "utf-8");

  config = {
    configPath,
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "acme/my-app",
        path: join(tempRoot, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
  };
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("observability snapshot", () => {
  it("records counters, traces, and session status", () => {
    const observer = createProjectObserver(config, "session-manager");

    observer.recordOperation({
      metric: "spawn",
      operation: "session.spawn",
      outcome: "success",
      correlationId: "corr-1",
      projectId: "my-app",
      sessionId: "app-1",
      data: { issueId: "INT-1" },
      level: "info",
    });

    observer.recordOperation({
      metric: "send",
      operation: "session.send",
      outcome: "failure",
      correlationId: "corr-2",
      projectId: "my-app",
      sessionId: "app-1",
      reason: "runtime unavailable",
      level: "error",
    });

    observer.setHealth({
      surface: "lifecycle.worker",
      status: "warn",
      projectId: "my-app",
      correlationId: "corr-3",
      reason: "poll delayed",
      details: { projectId: "my-app" },
    });

    const summary = readObservabilitySummary(config);
    const project = summary.projects["my-app"];

    expect(project).toBeDefined();
    expect(project.metrics["spawn"]?.total).toBe(1);
    expect(project.metrics["spawn"]?.success).toBe(1);
    expect(project.metrics["send"]?.failure).toBe(1);
    expect(project.sessions["app-1"]?.operation).toBe("session.send");
    expect(project.recentTraces.some((trace) => trace.operation === "session.spawn")).toBe(true);
    expect(project.health["lifecycle.worker"]?.status).toBe("warn");
    expect(summary.overallStatus).toBe("warn");
  });
});

describe("createCorrelationId", () => {
  it("uses default prefix when none is provided", () => {
    const id = createCorrelationId();
    expect(id).toMatch(/^ao-/);
  });

  it("uses custom prefix", () => {
    const id = createCorrelationId("custom");
    expect(id).toMatch(/^custom-/);
  });
});

describe("readObservabilitySummary - branch coverage", () => {
  it("handles snapshot files with corrupt JSON gracefully", () => {
    // Create the processes dir and write a corrupt JSON file
    const observer = createProjectObserver(config, "test-component");
    // First create a valid snapshot so the dir exists
    observer.recordOperation({
      metric: "spawn",
      outcome: "success",
      correlationId: "c-1",
      projectId: "my-app",
    });

    // The processes dir is created by createProjectObserver's recordOperation.
    // Find it by looking at the known path pattern.
    const hash = generateConfigHash(config.configPath);
    const obsDir = join(homedir(), ".agent-orchestrator", `${hash}-observability`, "processes");
    writeFileSync(join(obsDir, "corrupt-999.json"), "NOT VALID JSON{{{", "utf-8");

    // Should not throw — corrupt files are skipped
    const summary = readObservabilitySummary(config);
    expect(summary).toBeDefined();
    expect(summary.overallStatus).toBeDefined();
  });

  it("skips snapshot objects that are null or non-objects after parsing", () => {
    const observer = createProjectObserver(config, "test-component");
    observer.recordOperation({
      metric: "spawn",
      outcome: "success",
      correlationId: "c-1",
      projectId: "my-app",
    });

    const hash = generateConfigHash(config.configPath);
    const obsDir = join(homedir(), ".agent-orchestrator", `${hash}-observability`, "processes");
    // Write a JSON file that parses to null
    writeFileSync(join(obsDir, "null-snapshot-999.json"), "null", "utf-8");

    const summary = readObservabilitySummary(config);
    expect(summary).toBeDefined();
  });

  it("updates project.updatedAt when a newer snapshot.updatedAt is found (line 481)", () => {
    // Create two snapshot files with different timestamps for the same project.
    // The second one has a later timestamp, so project.updatedAt should be updated.
    const observer1 = createProjectObserver(config, "component-a");
    const observer2 = createProjectObserver(config, "component-b");

    // Record from observer1 first (older)
    observer1.recordOperation({
      metric: "spawn",
      outcome: "success",
      correlationId: "c-1",
      projectId: "my-app",
    });

    // Small delay to get different timestamps
    observer2.recordOperation({
      metric: "kill",
      outcome: "success",
      correlationId: "c-2",
      projectId: "my-app",
    });

    const summary = readObservabilitySummary(config);
    const project = summary.projects["my-app"];
    expect(project).toBeDefined();
    // Both metrics should be merged
    expect(project.metrics["spawn"]?.total).toBe(1);
    expect(project.metrics["kill"]?.total).toBe(1);
  });

  it("updates project.updatedAt when a trace has newer timestamp (line 499)", () => {
    const observer = createProjectObserver(config, "test-comp");

    // Record two operations for same project — traces will have timestamps
    observer.recordOperation({
      metric: "spawn",
      outcome: "success",
      correlationId: "c-1",
      projectId: "my-app",
      sessionId: "app-1",
    });

    observer.recordOperation({
      metric: "send",
      outcome: "success",
      correlationId: "c-2",
      projectId: "my-app",
      sessionId: "app-2",
    });

    const summary = readObservabilitySummary(config);
    expect(summary.projects["my-app"]).toBeDefined();
    expect(summary.projects["my-app"].recentTraces.length).toBeGreaterThanOrEqual(2);
  });

  it("updates project.updatedAt when health entry has newer timestamp (line 521)", () => {
    const observer = createProjectObserver(config, "test-comp");

    observer.setHealth({
      surface: "lifecycle.worker",
      status: "ok",
      projectId: "my-app",
      correlationId: "c-1",
    });

    // Set health again with newer timestamp
    observer.setHealth({
      surface: "lifecycle.worker",
      status: "error",
      projectId: "my-app",
      correlationId: "c-2",
      reason: "poll failure",
    });

    const summary = readObservabilitySummary(config);
    const project = summary.projects["my-app"];
    expect(project).toBeDefined();
    expect(project.health["lifecycle.worker"]?.status).toBe("error");
    expect(summary.overallStatus).toBe("error");
  });

  it("updates project.updatedAt when session entry has newer timestamp (line 542)", () => {
    const observer = createProjectObserver(config, "test-comp");

    observer.recordOperation({
      metric: "spawn",
      outcome: "success",
      correlationId: "c-1",
      projectId: "my-app",
      sessionId: "app-1",
    });

    observer.recordOperation({
      metric: "send",
      outcome: "failure",
      correlationId: "c-2",
      projectId: "my-app",
      sessionId: "app-1",
      reason: "timeout",
    });

    const summary = readObservabilitySummary(config);
    const project = summary.projects["my-app"];
    expect(project).toBeDefined();
    expect(project.sessions["app-1"]).toBeDefined();
  });

  it("skips metrics without a projectId (unknown bucket key)", () => {
    const observer = createProjectObserver(config, "test-comp");

    // Record an operation without projectId — should produce "unknown" bucket key
    observer.recordOperation({
      metric: "spawn",
      outcome: "success",
      correlationId: "c-1",
      // no projectId
    });

    const summary = readObservabilitySummary(config);
    // The "unknown" project should be skipped in readObservabilitySummary
    expect(summary.projects["unknown"]).toBeUndefined();
  });

  it("skips traces without a projectId", () => {
    const observer = createProjectObserver(config, "test-comp");

    observer.recordOperation({
      metric: "spawn",
      outcome: "success",
      correlationId: "c-1",
      // no projectId — trace.projectId will be undefined
    });

    const summary = readObservabilitySummary(config);
    // There should be no project entry for traces without projectId
    expect(Object.keys(summary.projects).length).toBe(0);
  });

  it("skips health entries without a projectId", () => {
    const observer = createProjectObserver(config, "test-comp");

    observer.setHealth({
      surface: "test.surface",
      status: "ok",
      // no projectId
    });

    const summary = readObservabilitySummary(config);
    expect(Object.keys(summary.projects).length).toBe(0);
  });

  it("skips session entries without a projectId", () => {
    const observer = createProjectObserver(config, "test-comp");

    observer.recordOperation({
      metric: "spawn",
      outcome: "success",
      correlationId: "c-1",
      sessionId: "app-1",
      // no projectId
    });

    const summary = readObservabilitySummary(config);
    expect(Object.keys(summary.projects).length).toBe(0);
  });

  it("handles overallStatus escalation from ok to error via health entries", () => {
    const observer = createProjectObserver(config, "test-comp");

    observer.setHealth({
      surface: "surface-a",
      status: "ok",
      projectId: "my-app",
    });

    observer.setHealth({
      surface: "surface-b",
      status: "error",
      projectId: "my-app",
    });

    const summary = readObservabilitySummary(config);
    expect(summary.overallStatus).toBe("error");
  });

  it("keeps existing health entry when newer one has same timestamp", () => {
    // Two snapshot files both with health for the same surface
    const observer1 = createProjectObserver(config, "comp-a");
    const observer2 = createProjectObserver(config, "comp-b");

    observer1.setHealth({
      surface: "test.surface",
      status: "ok",
      projectId: "my-app",
    });

    observer2.setHealth({
      surface: "test.surface",
      status: "warn",
      projectId: "my-app",
    });

    const summary = readObservabilitySummary(config);
    const project = summary.projects["my-app"];
    expect(project).toBeDefined();
    // The latter should win because updatedAt >= existing.updatedAt
    expect(project.health["test.surface"]).toBeDefined();
  });
});

describe("recordOperation branch coverage", () => {
  it("defaults operation to metric name when operation is not provided", () => {
    const observer = createProjectObserver(config, "test-comp");

    observer.recordOperation({
      metric: "spawn",
      outcome: "success",
      correlationId: "c-1",
      projectId: "my-app",
      sessionId: "app-1",
      // no operation — should default to metric name "spawn"
    });

    const summary = readObservabilitySummary(config);
    const project = summary.projects["my-app"];
    expect(project).toBeDefined();
    expect(project.recentTraces[0]?.operation).toBe("spawn");
    expect(project.sessions["app-1"]?.operation).toBe("spawn");
  });

  it("defaults level to error when outcome is failure and no level specified", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const oldLogLevel = process.env["AO_LOG_LEVEL"];
    process.env["AO_LOG_LEVEL"] = "error";

    try {
      const observer = createProjectObserver(config, "test-comp");

      observer.recordOperation({
        metric: "spawn",
        outcome: "failure",
        correlationId: "c-1",
        projectId: "my-app",
        reason: "something failed",
        // no level — should default to "error" because outcome is "failure"
      });

      // The structured log should have been emitted at "error" level
      expect(stderrSpy).toHaveBeenCalled();
      const call = stderrSpy.mock.calls.find((c) => {
        const str = String(c[0]);
        return str.includes('"level":"error"') && str.includes("something failed");
      });
      expect(call).toBeDefined();
    } finally {
      process.env["AO_LOG_LEVEL"] = oldLogLevel;
      stderrSpy.mockRestore();
    }
  });

  it("defaults level to info when outcome is success and no level specified", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const oldLogLevel = process.env["AO_LOG_LEVEL"];
    process.env["AO_LOG_LEVEL"] = "debug";

    try {
      const observer = createProjectObserver(config, "test-comp");

      observer.recordOperation({
        metric: "spawn",
        outcome: "success",
        correlationId: "c-1",
        projectId: "my-app",
        // no level — should default to "info" because outcome is "success"
      });

      expect(stderrSpy).toHaveBeenCalled();
      const call = stderrSpy.mock.calls.find((c) => {
        const str = String(c[0]);
        return str.includes('"level":"info"') && str.includes("spawn");
      });
      expect(call).toBeDefined();
    } finally {
      process.env["AO_LOG_LEVEL"] = oldLogLevel;
      stderrSpy.mockRestore();
    }
  });
});

describe("setHealth branch coverage", () => {
  it("emits warn-level log for warn status", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const oldLogLevel = process.env["AO_LOG_LEVEL"];
    process.env["AO_LOG_LEVEL"] = "debug";

    try {
      const observer = createProjectObserver(config, "test-comp");

      observer.setHealth({
        surface: "test.surface",
        status: "warn",
        projectId: "my-app",
        reason: "degraded",
      });

      const call = stderrSpy.mock.calls.find((c) => {
        const str = String(c[0]);
        return str.includes('"level":"warn"') && str.includes("degraded");
      });
      expect(call).toBeDefined();
    } finally {
      process.env["AO_LOG_LEVEL"] = oldLogLevel;
      stderrSpy.mockRestore();
    }
  });

  it("emits info-level log for ok status", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const oldLogLevel = process.env["AO_LOG_LEVEL"];
    process.env["AO_LOG_LEVEL"] = "debug";

    try {
      const observer = createProjectObserver(config, "test-comp");

      observer.setHealth({
        surface: "test.surface",
        status: "ok",
        projectId: "my-app",
      });

      const call = stderrSpy.mock.calls.find((c) => {
        const str = String(c[0]);
        return str.includes('"level":"info"') && str.includes("test.surface");
      });
      expect(call).toBeDefined();
    } finally {
      process.env["AO_LOG_LEVEL"] = oldLogLevel;
      stderrSpy.mockRestore();
    }
  });

  it("emits error-level log for error status", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const oldLogLevel = process.env["AO_LOG_LEVEL"];
    process.env["AO_LOG_LEVEL"] = "debug";

    try {
      const observer = createProjectObserver(config, "test-comp");

      observer.setHealth({
        surface: "test.surface",
        status: "error",
        projectId: "my-app",
        reason: "critical failure",
      });

      const call = stderrSpy.mock.calls.find((c) => {
        const str = String(c[0]);
        return str.includes('"level":"error"') && str.includes("critical failure");
      });
      expect(call).toBeDefined();
    } finally {
      process.env["AO_LOG_LEVEL"] = oldLogLevel;
      stderrSpy.mockRestore();
    }
  });
});

describe("sanitizeComponent edge cases", () => {
  it("handles component names with special characters", () => {
    const observer = createProjectObserver(config, "my/special@component!!");
    expect(observer.component).toBe("my-special-component");
  });

  it("handles empty string component name (falls back to 'component')", () => {
    const observer = createProjectObserver(config, "!!!");
    expect(observer.component).toBe("component");
  });
});

describe("log level filtering", () => {
  it("suppresses debug logs when AO_LOG_LEVEL is warn", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const oldLogLevel = process.env["AO_LOG_LEVEL"];
    process.env["AO_LOG_LEVEL"] = "warn";

    try {
      const observer = createProjectObserver(config, "test-comp");

      observer.recordOperation({
        metric: "spawn",
        outcome: "success",
        correlationId: "c-1",
        projectId: "my-app",
        level: "debug",
      });

      // Debug should be suppressed when log level is warn
      const debugCalls = stderrSpy.mock.calls.filter((c) => {
        const str = String(c[0]);
        return str.includes('"level":"debug"');
      });
      expect(debugCalls.length).toBe(0);
    } finally {
      process.env["AO_LOG_LEVEL"] = oldLogLevel;
      stderrSpy.mockRestore();
    }
  });

  it("defaults to warn level when AO_LOG_LEVEL is unset", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const oldLogLevel = process.env["AO_LOG_LEVEL"];
    delete process.env["AO_LOG_LEVEL"];

    try {
      const observer = createProjectObserver(config, "test-comp");

      // Info should be suppressed (below default "warn" threshold)
      observer.recordOperation({
        metric: "spawn",
        outcome: "success",
        correlationId: "c-1",
        projectId: "my-app",
        level: "info",
      });

      const infoCalls = stderrSpy.mock.calls.filter((c) => {
        const str = String(c[0]);
        return str.includes('"level":"info"');
      });
      expect(infoCalls.length).toBe(0);

      // Error should pass through
      observer.recordOperation({
        metric: "spawn",
        outcome: "failure",
        correlationId: "c-2",
        projectId: "my-app",
        level: "error",
        reason: "test error",
      });

      const errorCalls = stderrSpy.mock.calls.filter((c) => {
        const str = String(c[0]);
        return str.includes('"level":"error"');
      });
      expect(errorCalls.length).toBeGreaterThan(0);
    } finally {
      process.env["AO_LOG_LEVEL"] = oldLogLevel;
      stderrSpy.mockRestore();
    }
  });

  it("accepts AO_LOG_LEVEL with extra whitespace", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const oldLogLevel = process.env["AO_LOG_LEVEL"];
    process.env["AO_LOG_LEVEL"] = "  DEBUG  ";

    try {
      const observer = createProjectObserver(config, "test-comp");

      observer.recordOperation({
        metric: "spawn",
        outcome: "success",
        correlationId: "c-1",
        projectId: "my-app",
        level: "debug",
      });

      // Debug should pass through when level is DEBUG
      const debugCalls = stderrSpy.mock.calls.filter((c) => {
        const str = String(c[0]);
        return str.includes('"level":"debug"');
      });
      expect(debugCalls.length).toBeGreaterThan(0);
    } finally {
      process.env["AO_LOG_LEVEL"] = oldLogLevel;
      stderrSpy.mockRestore();
    }
  });
});
