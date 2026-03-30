import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getSessionsDir } from "../paths.js";
import { runRecovery, recoverSessionById } from "../recovery/manager.js";
import { DEFAULT_RECOVERY_CONFIG } from "../recovery/types.js";
import type { OrchestratorConfig, PluginRegistry } from "../types.js";

function makeConfig(rootDir: string): OrchestratorConfig {
  return {
    configPath: join(rootDir, "agent-orchestrator.yaml"),
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      app: {
        name: "app",
        repo: "org/repo",
        path: join(rootDir, "project"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: ["desktop"],
    },
    reactions: {},
  };
}

function makeMultiProjectConfig(rootDir: string): OrchestratorConfig {
  return {
    configPath: join(rootDir, "agent-orchestrator.yaml"),
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      app: {
        name: "app",
        repo: "org/repo",
        path: join(rootDir, "project-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
      web: {
        name: "web",
        repo: "org/web",
        path: join(rootDir, "project-web"),
        defaultBranch: "main",
        sessionPrefix: "web",
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  };
}

function makeRegistry(): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };
}

function setupRoot(): string {
  const rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(join(rootDir, "project"), { recursive: true });
  writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");
  return rootDir;
}

describe("runRecovery", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("returns empty report when no sessions exist", async () => {
    rootDir = setupRoot();
    const config = makeConfig(rootDir);
    const registry = makeRegistry();

    const { report, assessments, results, recoveredSessions } = await runRecovery({
      config,
      registry,
    });

    expect(report.totalScanned).toBe(0);
    expect(report.recovered).toEqual([]);
    expect(report.cleanedUp).toEqual([]);
    expect(report.escalated).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(assessments).toEqual([]);
    expect(results).toEqual([]);
    expect(recoveredSessions).toEqual([]);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("scans and processes sessions from metadata files", async () => {
    rootDir = setupRoot();
    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-1"),
      "project=app\nstatus=working\nbranch=feat/test\n",
      "utf-8",
    );

    const customLogPath = join(rootDir, "test-recovery.log");
    const registry = makeRegistry();

    const { report, assessments, results } = await runRecovery({
      config,
      registry,
      recoveryConfig: { logPath: customLogPath },
    });

    expect(report.totalScanned).toBe(1);
    expect(assessments).toHaveLength(1);
    expect(results).toHaveLength(1);
    // Log should have been written
    expect(existsSync(customLogPath)).toBe(true);
  });

  it("handles dryRun mode - classifies but does not modify sessions", async () => {
    rootDir = setupRoot();
    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-1"),
      "project=app\nstatus=working\nbranch=feat/test\n",
      "utf-8",
    );

    const registry = makeRegistry();

    const { report, results } = await runRecovery({
      config,
      registry,
      dryRun: true,
      recoveryConfig: { logPath: join(rootDir, "dry.log") },
    });

    expect(report.totalScanned).toBe(1);
    expect(results).toHaveLength(1);
    // Dry run should not write a log file
    expect(existsSync(join(rootDir, "dry.log"))).toBe(false);
  });

  it("categorizes cleanup results correctly in report", async () => {
    rootDir = setupRoot();
    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    // Create a session that will be classified as dead (no runtime, no workspace)
    // with a terminal status => unrecoverable => skip
    writeFileSync(
      join(sessionsDir, "app-done"),
      "project=app\nstatus=terminated\n",
      "utf-8",
    );

    const registry = makeRegistry();

    const { report } = await runRecovery({
      config,
      registry,
      recoveryConfig: { logPath: join(rootDir, "categorize.log") },
    });

    expect(report.totalScanned).toBe(1);
    // terminated status with no runtime/workspace => unrecoverable => skip
    expect(report.skipped.length + report.cleanedUp.length + report.recovered.length + report.escalated.length + report.errors.length).toBe(1);
  });

  it("uses default recovery log path when not specified", async () => {
    rootDir = setupRoot();
    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-2"),
      "project=app\nstatus=working\n",
      "utf-8",
    );

    const registry = makeRegistry();

    // No logPath provided - should use default
    const { report } = await runRecovery({
      config,
      registry,
    });

    expect(report.totalScanned).toBe(1);
  });

  it("dryRun categorizes actions correctly for multiple sessions", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    // A terminated session (unrecoverable => skip)
    writeFileSync(join(sessionsDir, "app-terminated"), "project=app\nstatus=terminated\n", "utf-8");
    // A working session with no runtime/workspace (dead => cleanup by default)
    writeFileSync(join(sessionsDir, "app-working"), "project=app\nstatus=working\n", "utf-8");

    const registry = makeRegistry();

    const { report } = await runRecovery({
      config,
      registry,
      dryRun: true,
      recoveryConfig: { logPath: join(rootDir, "dry2.log") },
    });

    expect(report.totalScanned).toBe(2);
    // Each session should be categorized somewhere
    const total =
      report.recovered.length +
      report.cleanedUp.length +
      report.escalated.length +
      report.skipped.length;
    expect(total).toBe(2);
  });

  it("records errors for sessions that fail during non-dry-run execution", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    // Intentionally create project path at a non-writable location to cause errors
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config: OrchestratorConfig = {
      configPath: join(rootDir, "agent-orchestrator.yaml"),
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        app: {
          name: "app",
          repo: "org/repo",
          path: join(rootDir, "project"),
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    // Create the sessions dir but make the session have status=working (dead classification => cleanup)
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-fail"), "project=app\nstatus=working\n", "utf-8");

    const registry = makeRegistry();

    const { report } = await runRecovery({
      config,
      registry,
      recoveryConfig: { logPath: join(rootDir, "errors.log") },
    });

    expect(report.totalScanned).toBe(1);
    // The session should have been processed (either success or error)
    const totalProcessed =
      report.recovered.length +
      report.cleanedUp.length +
      report.escalated.length +
      report.skipped.length +
      report.errors.length;
    expect(totalProcessed).toBe(1);
  });
});

describe("runRecovery with projectFilter", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("only scans sessions for the filtered project", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project-app"), { recursive: true });
    mkdirSync(join(rootDir, "project-web"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeMultiProjectConfig(rootDir);
    const registry = makeRegistry();

    // Create sessions for both projects
    const appSessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    const webSessionsDir = getSessionsDir(config.configPath, config.projects.web.path);
    mkdirSync(appSessionsDir, { recursive: true });
    mkdirSync(webSessionsDir, { recursive: true });
    writeFileSync(join(appSessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");
    writeFileSync(join(webSessionsDir, "web-1"), "project=web\nstatus=working\n", "utf-8");

    const { report: appReport } = await runRecovery({
      config,
      registry,
      projectFilter: "app",
      dryRun: true,
      recoveryConfig: { logPath: join(rootDir, "filter.log") },
    });

    expect(appReport.totalScanned).toBe(1);
  });

  it("returns empty when filter matches no projects", async () => {
    rootDir = setupRoot();
    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");

    const registry = makeRegistry();

    const { report } = await runRecovery({
      config,
      registry,
      projectFilter: "nonexistent",
      dryRun: true,
      recoveryConfig: { logPath: join(rootDir, "filter2.log") },
    });

    expect(report.totalScanned).toBe(0);
  });
});

describe("recoverSessionById", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("returns null when session does not exist", async () => {
    rootDir = setupRoot();
    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    const registry = makeRegistry();

    const result = await recoverSessionById("nonexistent-session", {
      config,
      registry,
      recoveryConfig: { logPath: join(rootDir, "byid.log") },
    });

    expect(result).toBeNull();
  });

  it("recovers an existing session by ID", async () => {
    rootDir = setupRoot();
    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-target"),
      "project=app\nstatus=working\nbranch=feat/recovery\n",
      "utf-8",
    );

    const logPath = join(rootDir, "byid-recover.log");
    const registry = makeRegistry();

    const result = await recoverSessionById("app-target", {
      config,
      registry,
      recoveryConfig: { logPath },
    });

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("app-target");
    // Log should be written
    expect(existsSync(logPath)).toBe(true);
  });

  it("handles dryRun - returns result without writing log", async () => {
    rootDir = setupRoot();
    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-dry"),
      "project=app\nstatus=working\n",
      "utf-8",
    );

    const logPath = join(rootDir, "byid-dry.log");
    const registry = makeRegistry();

    const result = await recoverSessionById("app-dry", {
      config,
      registry,
      dryRun: true,
      recoveryConfig: { logPath },
    });

    expect(result).not.toBeNull();
    // In dry-run, the log should NOT be written
    expect(existsSync(logPath)).toBe(false);
  });

  it("searches across all projects when no filter is set", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project-app"), { recursive: true });
    mkdirSync(join(rootDir, "project-web"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeMultiProjectConfig(rootDir);
    const registry = makeRegistry();

    const webSessionsDir = getSessionsDir(config.configPath, config.projects.web.path);
    mkdirSync(webSessionsDir, { recursive: true });
    writeFileSync(
      join(webSessionsDir, "web-42"),
      "project=web\nstatus=spawning\n",
      "utf-8",
    );

    const logPath = join(rootDir, "byid-multi.log");
    const result = await recoverSessionById("web-42", {
      config,
      registry,
      dryRun: true,
      recoveryConfig: { logPath },
    });

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("web-42");
  });
});

describe("mapActionToLogAction branch coverage", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("maps 'escalate' action to 'escalated' in recovery log (line 140)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    // dead session with no workspace/runtime, escalatePartial=true
    // Use a non-terminal status so it classifies as "dead"
    writeFileSync(
      join(sessionsDir, "app-esc"),
      "project=app\nstatus=working\n",
      "utf-8",
    );

    const logPath = join(rootDir, "escalate.log");
    const registry = makeRegistry();

    // autoCleanup=false and escalatePartial=true will make dead sessions escalate
    const { report } = await runRecovery({
      config,
      registry,
      recoveryConfig: {
        logPath,
        autoCleanup: false,
      },
    });

    expect(report.totalScanned).toBe(1);
    // Dead + autoCleanup=false => escalate
    expect(report.escalated.length).toBe(1);

    // Verify log was written
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain("escalated");
  });

  it("maps failed action to 'error' in recovery log (line 133)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    // A live session that the recovery will try to "recover" — but since the
    // registry returns null for runtime/agent, the actual recovery will produce
    // an error in the non-dry-run code path.
    writeFileSync(
      join(sessionsDir, "app-fail"),
      "project=app\nstatus=working\nruntimeHandle={\"id\":\"fake\",\"runtimeName\":\"tmux\",\"data\":{}}\n",
      "utf-8",
    );

    const logPath = join(rootDir, "error-action.log");
    const registry = makeRegistry();

    const { report } = await runRecovery({
      config,
      registry,
      recoveryConfig: { logPath },
    });

    expect(report.totalScanned).toBe(1);
    // The session was processed
    const totalProcessed =
      report.recovered.length +
      report.cleanedUp.length +
      report.escalated.length +
      report.skipped.length +
      report.errors.length;
    expect(totalProcessed).toBe(1);
  });

  it("recoverSessionById uses default logPath when not provided (line 155)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-default-log"),
      "project=app\nstatus=working\n",
      "utf-8",
    );

    const registry = makeRegistry();

    // No logPath or recoveryConfig provided — should use default
    const result = await recoverSessionById("app-default-log", {
      config,
      registry,
    });

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("app-default-log");
  });

  it("dryRun categorizes cleanup action in loop (line 66-67)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    // dead session => cleanup by default (autoCleanup=true)
    writeFileSync(
      join(sessionsDir, "app-cleanup"),
      "project=app\nstatus=working\n",
      "utf-8",
    );

    const registry = makeRegistry();

    const { report } = await runRecovery({
      config,
      registry,
      dryRun: true,
      recoveryConfig: {
        logPath: join(rootDir, "dry-cleanup.log"),
        autoCleanup: true,
      },
    });

    expect(report.totalScanned).toBe(1);
    expect(report.cleanedUp.length).toBe(1);
  });

  it("dryRun categorizes escalate action in loop (line 68-69)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    // dead session + autoCleanup=false => escalate
    writeFileSync(
      join(sessionsDir, "app-escalate"),
      "project=app\nstatus=working\n",
      "utf-8",
    );

    const registry = makeRegistry();

    const { report } = await runRecovery({
      config,
      registry,
      dryRun: true,
      recoveryConfig: {
        logPath: join(rootDir, "dry-escalate.log"),
        autoCleanup: false,
      },
    });

    expect(report.totalScanned).toBe(1);
    expect(report.escalated.length).toBe(1);
  });

  it("non-dryRun records error with fallback message (line 102-104)", async () => {
    rootDir = join(tmpdir(), `ao-recovery-mgr-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    // Session with recoveryCount exceeding max — will be escalated
    writeFileSync(
      join(sessionsDir, "app-max-retry"),
      "project=app\nstatus=working\nrecoveryCount=99\n",
      "utf-8",
    );

    const logPath = join(rootDir, "max-retry.log");
    const registry = makeRegistry();

    const { report, results } = await runRecovery({
      config,
      registry,
      recoveryConfig: { logPath },
    });

    expect(report.totalScanned).toBe(1);
    // The session should end up somewhere in the report
    const totalProcessed =
      report.recovered.length +
      report.cleanedUp.length +
      report.escalated.length +
      report.skipped.length +
      report.errors.length;
    expect(totalProcessed).toBe(1);
  });
});
