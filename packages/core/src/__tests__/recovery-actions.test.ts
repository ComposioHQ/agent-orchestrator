import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readMetadataRaw } from "../metadata.js";
import { getSessionsDir, getProjectBaseDir } from "../paths.js";
import { cleanupSession, escalateSession, recoverSession } from "../recovery/actions.js";
import { runRecovery } from "../recovery/manager.js";
import { getRecoveryLogPath, scanAllSessions } from "../recovery/scanner.js";
import {
  DEFAULT_RECOVERY_CONFIG,
  type RecoveryAssessment,
  type RecoveryContext,
} from "../recovery/types.js";
import type { OrchestratorConfig, PluginRegistry, Runtime, Workspace } from "../types.js";

function makeConfig(rootDir: string): OrchestratorConfig {
  return {
    configPath: join(rootDir, "agent-orchestrator.yaml"),
    port: 3000,
    readyThresholdMs: 300_000,
    power: { preventIdleSleep: false },
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

function makeRegistry(): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn().mockResolvedValue(undefined),
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAssessment(overrides: Partial<RecoveryAssessment> = {}): RecoveryAssessment {
  return {
    sessionId: "app-1",
    projectId: "app",
    classification: "live",
    action: "recover",
    reason: "Session is running normally",
    runtimeProbeSucceeded: true,
    processProbeSucceeded: true,
    signalDisagreement: false,
    recoveryRule: "auto",
    runtimeAlive: true,
    runtimeHandle: { id: "rt-1", runtimeName: "tmux", data: {} },
    workspaceExists: true,
    workspacePath: "/tmp/worktree",
    agentProcessRunning: true,
    agentActivity: "active",
    metadataValid: true,
    metadataStatus: "working",
    rawMetadata: {
      project: "app",
      branch: "feat/test",
      issue: "123",
      pr: "https://github.com/org/repo/pull/42",
      createdAt: "2025-01-01T00:00:00.000Z",
      status: "working",
      summary: "Recovered summary",
    },
    ...overrides,
  };
}

function makeContext(rootDir: string, overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    configPath: join(rootDir, "agent-orchestrator.yaml"),
    recoveryConfig: {
      ...DEFAULT_RECOVERY_CONFIG,
      logPath: join(rootDir, "recovery.log"),
    },
    dryRun: false,
    ...overrides,
  };
}

describe("recoverSession", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      const configPath = join(rootDir, "agent-orchestrator.yaml");
      const projectPath = join(rootDir, "project");
      const projectBaseDir = getProjectBaseDir(configPath, projectPath);
      if (existsSync(projectBaseDir)) {
        rmSync(projectBaseDir, { recursive: true, force: true });
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("persists restoredAt and returns a session with restoredAt", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment();
    const context = makeContext(rootDir);

    const result = await recoverSession(assessment, config, registry, context);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    const metadata = readMetadataRaw(sessionsDir, assessment.sessionId);

    expect(result.success).toBe(true);
    expect(result.session?.restoredAt).toBeInstanceOf(Date);
    expect(metadata?.["restoredAt"]).toBeDefined();
    expect(metadata?.["recoveredAt"]).toBeUndefined();
  });

  it("preserves project ownership when legacy metadata omits the project field", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        branch: "feature/recover",
        worktree: join(rootDir, "project"),
        status: "needs_input",
      },
    });
    const context = makeContext(rootDir);

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.session?.projectId).toBe("app");
  });

  it("returns the max-attempt reason when recovery escalates", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        recoveryCount: "3",
      },
    });
    const context = makeContext(rootDir, {
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
        maxRecoveryAttempts: 3,
      },
    });

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("Exceeded max recovery attempts (3)");
  });

  it("dry-run recovery reports escalate when attempts exceed limit", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        recoveryCount: "3",
      },
    });
    const context = makeContext(rootDir, {
      dryRun: true,
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: join(rootDir, "recovery.log"),
        maxRecoveryAttempts: 3,
      },
    });

    const result = await recoverSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.requiresManualIntervention).toBe(true);
    expect(result.reason).toBe("Exceeded max recovery attempts (3)");
  });

  it("calls context.invalidateCache() after mutating metadata", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment();
    const invalidateCache = vi.fn();
    const context = makeContext(rootDir, { invalidateCache });

    await recoverSession(assessment, config, registry, context);

    expect(invalidateCache).toHaveBeenCalled();
  });
});

describe("escalateSession", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      const configPath = join(rootDir, "agent-orchestrator.yaml");
      const projectPath = join(rootDir, "project");
      const projectBaseDir = getProjectBaseDir(configPath, projectPath);
      if (existsSync(projectBaseDir)) {
        rmSync(projectBaseDir, { recursive: true, force: true });
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uses the assessment reason during dry runs", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const registry = makeRegistry();
    const assessment = makeAssessment({
      action: "escalate",
      classification: "partial",
      reason: "Workspace exists but runtime is missing",
    });
    const context = makeContext(rootDir, { dryRun: true });

    const result = await escalateSession(assessment, config, registry, context);

    expect(result.success).toBe(true);
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("Workspace exists but runtime is missing");
  });
});

describe("cleanupSession", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      const configPath = join(rootDir, "agent-orchestrator.yaml");
      const projectPath = join(rootDir, "project");
      const projectBaseDir = getProjectBaseDir(configPath, projectPath);
      if (existsSync(projectBaseDir)) {
        rmSync(projectBaseDir, { recursive: true, force: true });
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("continues cleanup and calls deleteMetadata even when workspace.destroy throws", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const workspacePath = join(rootDir, "worktree");
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn().mockRejectedValue(new Error("Workspace destroy failed")),
      list: vi.fn(),
      exists: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const assessment = makeAssessment({
      action: "cleanup",
      classification: "dead",
      runtimeAlive: false,
      workspaceExists: true,
      workspacePath,
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        worktree: workspacePath,
      },
    });
    const context = makeContext(rootDir);

    const result = await cleanupSession(assessment, config, registry, context);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);

    expect(mockWorkspace.destroy).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(existsSync(join(sessionsDir, "app-1"))).toBe(false);
  });

  it("continues cleanup and calls workspace.destroy and deleteMetadata even when runtime.destroy throws", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const workspacePath = join(rootDir, "worktree");
    const mockRuntime: Runtime = {
      name: "tmux",
      create: vi.fn(),
      destroy: vi.fn().mockRejectedValue(new Error("Runtime destroy failed")),
      sendMessage: vi.fn(),
      getOutput: vi.fn(),
      isAlive: vi.fn(),
    };
    const mockWorkspace: Workspace = {
      name: "worktree",
      create: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      list: vi.fn(),
      exists: vi.fn(),
    };
    const registry: PluginRegistry = {
      register: vi.fn(),
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return mockRuntime;
        if (slot === "workspace") return mockWorkspace;
        return null;
      }),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn().mockResolvedValue(undefined),
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
    };
    const assessment = makeAssessment({
      action: "cleanup",
      classification: "partial",
      runtimeAlive: true,
      workspaceExists: true,
      workspacePath,
      rawMetadata: {
        ...makeAssessment().rawMetadata,
        worktree: workspacePath,
      },
    });
    const context = makeContext(rootDir);

    const result = await cleanupSession(assessment, config, registry, context);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);

    expect(mockRuntime.destroy).toHaveBeenCalled();
    expect(mockWorkspace.destroy).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(existsSync(join(sessionsDir, "app-1"))).toBe(false);
  });
});

describe("recovery manager and scanner", () => {
  let rootDir: string;

  afterEach(() => {
    if (rootDir) {
      const configPath = join(rootDir, "agent-orchestrator.yaml");
      const projectPath = join(rootDir, "project");
      const projectBaseDir = getProjectBaseDir(configPath, projectPath);
      if (existsSync(projectBaseDir)) {
        rmSync(projectBaseDir, { recursive: true, force: true });
      }
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("respects custom recovery logPath in manager options", async () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, "app-1"),
      "project=app\nstatus=terminated\nworktree=/tmp/worktree\n",
      "utf-8",
    );

    const customLogPath = join(rootDir, "custom-recovery.log");
    const registry = makeRegistry();

    await runRecovery({
      config,
      registry,
      recoveryConfig: {
        ...DEFAULT_RECOVERY_CONFIG,
        logPath: customLogPath,
      },
    });

    expect(existsSync(customLogPath)).toBe(true);
    expect(readFileSync(customLogPath, "utf-8")).toContain('"sessionId":"app-1"');

    const defaultLogPath = getRecoveryLogPath(config.configPath);
    expect(defaultLogPath).not.toBe(customLogPath);
  });

  it("scans sessions using metadata listing rules", () => {
    rootDir = join(tmpdir(), `ao-recovery-${randomUUID()}`);
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(join(rootDir, "project"), { recursive: true });
    writeFileSync(join(rootDir, "agent-orchestrator.yaml"), "projects: {}\n", "utf-8");

    const config = makeConfig(rootDir);
    const sessionsDir = getSessionsDir(config.configPath, config.projects.app.path);
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(sessionsDir, "app-1"), "project=app\nstatus=working\n", "utf-8");
    writeFileSync(join(sessionsDir, ".tmp"), "project=app\n", "utf-8");
    writeFileSync(join(sessionsDir, "bad.session"), "project=app\n", "utf-8");

    const scanned = scanAllSessions(config);

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.sessionId).toBe("app-1");
  });
});
