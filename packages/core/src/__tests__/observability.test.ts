import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createProjectObserver,
  readObservabilitySummary,
  type OrchestratorConfig,
} from "../index.js";

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
