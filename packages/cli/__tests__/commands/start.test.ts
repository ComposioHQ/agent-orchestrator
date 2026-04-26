/**
 * Tests for `ao start` and `ao stop` commands.
 *
 * Uses --no-dashboard --no-orchestrator flags to isolate project resolution
 * and URL handling logic from dashboard/session infrastructure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { SessionManager } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockExec,
  mockExecSilent,
  mockConfigRef,
  mockSessionManager,
  mockWaitForPortAndOpen,
  mockSpawn,
  mockEnsureLifecycleWorker,
} = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExecSilent: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
    restore: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    ensureOrchestrator: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  },
  mockWaitForPortAndOpen: vi.fn().mockResolvedValue(undefined),
  mockSpawn: vi.fn(),
  mockEnsureLifecycleWorker: vi.fn(),
}));

const { mockDetectOpenClawInstallation } = vi.hoisted(() => ({
  mockDetectOpenClawInstallation: vi.fn(),
}));

const { mockProcessCwd } = vi.hoisted(() => ({
  mockProcessCwd: vi.fn<[], string>(),
}));

const { mockPromptSelect, mockPromptConfirm } = vi.hoisted(() => ({
  mockPromptSelect: vi.fn(),
  mockPromptConfirm: vi.fn().mockResolvedValue(true),
}));

const { mockAcquireStartupLock, mockIsAlreadyRunning, mockRegister, mockUnregister, mockWaitForExit } = vi.hoisted(() => ({
  mockAcquireStartupLock: vi.fn().mockResolvedValue(() => {}),
  mockIsAlreadyRunning: vi.fn().mockReturnValue(null),
  mockRegister: vi.fn(),
  mockUnregister: vi.fn(),
  mockWaitForExit: vi.fn().mockReturnValue(true),
}));

const { mockIsHumanCaller } = vi.hoisted(() => ({
  mockIsHumanCaller: vi.fn().mockReturnValue(true),
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: vi.fn(),
  exec: mockExec,
  execSilent: mockExecSilent,
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: vi.fn().mockResolvedValue([]),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  const normalizeOrchestratorSessionStrategy =
    actual.normalizeOrchestratorSessionStrategy ??
    ((strategy: string | undefined) => {
      if (strategy === "kill-previous" || strategy === "delete-new") return "delete";
      if (strategy === "ignore-new") return "ignore";
      return strategy ?? "reuse";
    });

  return {
    ...actual,
    normalizeOrchestratorSessionStrategy,
    loadConfig: (path?: string) => {
      if (path) return actual.loadConfig(path);
      return mockConfigRef.current;
    },
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  ensureLifecycleWorker: (...args: unknown[]) => mockEnsureLifecycleWorker(...args),
  stopAllLifecycleWorkers: vi.fn(),
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  findWebDir: vi.fn().mockReturnValue("/fake/web"),
  buildDashboardEnv: vi.fn().mockResolvedValue({}),
  waitForPortAndOpen: (...args: unknown[]) => mockWaitForPortAndOpen(...args),
  isPortAvailable: vi.fn().mockResolvedValue(true),
  findFreePort: vi.fn().mockResolvedValue(3000),
  MAX_PORT_SCAN: 100,
}));

vi.mock("../../src/lib/dashboard-rebuild.js", () => ({
  findRunningDashboardPid: vi.fn().mockResolvedValue(null),
  rebuildDashboardProductionArtifacts: vi.fn().mockResolvedValue(undefined),
  waitForPortFree: vi.fn(),
}));

vi.mock("../../src/lib/preflight.js", () => ({
  preflight: {
    checkPort: vi.fn(),
    checkBuilt: vi.fn(),
    checkTmux: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../src/lib/running-state.js", () => ({
  acquireStartupLock: (...args: unknown[]) => mockAcquireStartupLock(...args),
  register: (...args: unknown[]) => mockRegister(...args),
  unregister: (...args: unknown[]) => mockUnregister(...args),
  isAlreadyRunning: (...args: unknown[]) => mockIsAlreadyRunning(...args),
  getRunning: vi.fn().mockReturnValue(null),
  waitForExit: (...args: unknown[]) => mockWaitForExit(...args),
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: (...args: unknown[]) => mockIsHumanCaller(...args),
  getCallerType: vi.fn().mockReturnValue("human"),
}));

vi.mock("../../src/lib/detect-env.js", () => ({
  detectEnvironment: vi.fn().mockResolvedValue({
    git: { isRepo: true, remoteUrl: null, ownerRepo: null, currentBranch: "main", defaultBranch: "main" },
    tools: { hasTmux: true, hasGh: false, ghAuthed: false },
    apiKeys: { hasLinear: false, hasSlack: false },
  }),
}));

vi.mock("../../src/lib/detect-agent.js", () => ({
  detectAgentRuntime: vi.fn().mockResolvedValue("claude-code"),
  detectAvailableAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lib/project-detection.js", () => ({
  detectProjectType: vi.fn().mockReturnValue({ languages: [], frameworks: [] }),
  generateRulesFromTemplates: vi.fn().mockReturnValue(null),
  formatProjectTypeForDisplay: vi.fn().mockReturnValue(""),
}));

vi.mock("../../src/lib/openclaw-probe.js", () => ({
  detectOpenClawInstallation: (...args: unknown[]) => mockDetectOpenClawInstallation(...args),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptSelect: (...args: unknown[]) => mockPromptSelect(...args),
  promptConfirm: (...args: unknown[]) => mockPromptConfirm(...args),
}));

// Mock node:child_process — start.ts imports spawn for dashboard + browser open
vi.mock("node:child_process", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

// Mock node:process so that `import { cwd } from "node:process"` in start.ts
// can be intercepted per-test via mockProcessCwd.
vi.mock("node:process", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:process")>();
  return {
    ...actual,
    cwd: () => {
      const override = mockProcessCwd();
      return override ?? actual.cwd();
    },
  };
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

import { Command } from "commander";
import { registerStart, registerStop, createConfigOnly } from "../../src/commands/start.js";

let tmpDir: string;
let program: Command;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-start-test-"));

  program = new Command();
  program.exitOverride();
  registerStart(program);
  registerStop(program);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  // Default: mock spawn to return a fake child process
  const fakeChild = { on: vi.fn(), kill: vi.fn(), emit: vi.fn(), stdout: null, stderr: null };
  mockSpawn.mockReturnValue(fakeChild);

  // Re-prime web-dir mocks defeated by afterEach's vi.restoreAllMocks().
  // Without this, findFreePort/isPortAvailable return `undefined`, which makes
  // dashboard-enabled tests print `http://localhost:undefined` and fail in
  // confusing ways.
  const webDir = await import("../../src/lib/web-dir.js");
  vi.mocked(webDir.findWebDir).mockReturnValue("/fake/web");
  vi.mocked(webDir.isPortAvailable).mockResolvedValue(true);
  vi.mocked(webDir.findFreePort).mockResolvedValue(3000);
  vi.mocked(webDir.buildDashboardEnv).mockResolvedValue({});
  const projectDetection = await import("../../src/lib/project-detection.js");
  vi.mocked(projectDetection.detectProjectType).mockReturnValue({ languages: [], frameworks: [] });
  vi.mocked(projectDetection.generateRulesFromTemplates).mockReturnValue(null);
  vi.mocked(projectDetection.formatProjectTypeForDisplay).mockReturnValue("");

  mockSessionManager.list.mockReset();
  mockSessionManager.list.mockResolvedValue([]);
  mockSessionManager.restore.mockReset();
  mockSessionManager.restore.mockResolvedValue({ id: "app-orchestrator-restored" });
  mockSessionManager.get.mockReset();
  mockSessionManager.get.mockImplementation(async (id: string) => {
    const sessions = await mockSessionManager.list("my-app");
    return sessions.find((session: { id: string }) => session.id === id) ?? null;
  });
  mockSessionManager.spawnOrchestrator.mockReset();
  mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });
  mockSessionManager.ensureOrchestrator.mockReset();
  mockSessionManager.ensureOrchestrator.mockImplementation(async (args) => {
    const existing = await mockSessionManager.get("app-orchestrator");
    if (existing) {
      if (
        existing.status === "killed" ||
        existing.status === "done" ||
        existing.status === "terminated" ||
        existing.activity === "exited"
      ) {
        return mockSessionManager.restore(existing.id);
      }
      return existing;
    }
    return mockSessionManager.spawnOrchestrator(args);
  });
  mockSessionManager.kill.mockReset();
  mockExec.mockReset();
  mockExecSilent.mockReset();
  // Default command availability:
  // - git and tmux are installed
  // - gh auth is unavailable (clone falls through to git SSH/HTTPS)
  mockExecSilent.mockImplementation(async (cmd: string, args: string[] = []) => {
    if (cmd === "git" && args[0] === "--version") return "git version 2.43.0";
    if (cmd === "tmux" && args[0] === "-V") return "tmux 3.4";
    if (cmd === "gh" && args[0] === "--version") return null;
    if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return null;
    return null;
  });
  mockWaitForPortAndOpen.mockReset();
  mockWaitForPortAndOpen.mockResolvedValue(undefined);
  mockEnsureLifecycleWorker.mockReset();
  mockEnsureLifecycleWorker.mockResolvedValue({
    running: true,
    started: true,
  });
  mockDetectOpenClawInstallation.mockReset();
  mockDetectOpenClawInstallation.mockResolvedValue({
    state: "missing",
    gatewayUrl: "http://127.0.0.1:18789",
    probe: { reachable: false, error: "not running" },
  });
  mockSpawn.mockClear();
  mockProcessCwd.mockReset();
  mockPromptSelect.mockReset();
  mockPromptConfirm.mockReset();
  mockPromptConfirm.mockResolvedValue(true);
  mockAcquireStartupLock.mockReset();
  mockAcquireStartupLock.mockResolvedValue(() => {});
  mockIsAlreadyRunning.mockReset();
  mockIsAlreadyRunning.mockResolvedValue(null);
  mockRegister.mockReset();
  mockRegister.mockResolvedValue(undefined);
  mockUnregister.mockReset();
  mockWaitForExit.mockReset();
  mockWaitForExit.mockResolvedValue(true);
  mockIsHumanCaller.mockReset();
  mockIsHumanCaller.mockReturnValue(true);
});

afterEach(() => {
  if (cwdSpy) cwdSpy.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(projects: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    configPath: join(tmpDir, "agent-orchestrator.yaml"),
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects,
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };
}

function makeProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "My App",
    repo: "org/my-app",
    path: join(tmpDir, "main-repo"),
    defaultBranch: "main",
    sessionPrefix: "app",
    ...overrides,
  };
}

/** Mock process.cwd() to return a specific directory (avoids process.chdir in workers). */
function mockCwd(dir: string): void {
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
}

/** Create a fake git repo directory with an origin remote URL. */
function createFakeRepo(dir: string, remoteUrl: string, files?: Record<string, string>): void {
  mkdirSync(join(dir, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "remotes", "origin", "main"), "abc\n");
  writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remoteUrl}\n`);
  if (files) {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
  }
}

// ---------------------------------------------------------------------------
// resolveProject (tested through `ao start` with --no-dashboard --no-orchestrator)
// ---------------------------------------------------------------------------

describe("start command — project resolution", () => {
  it("uses single project when no arg given", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("My App");
    expect(output).toContain("Startup complete");
  });

  it("uses explicit project arg when given", async () => {
    mockConfigRef.current = makeConfig({
      frontend: makeProject({ name: "Frontend", sessionPrefix: "fe" }),
      backend: makeProject({ name: "Backend", sessionPrefix: "api" }),
    });

    await program.parseAsync([
      "node",
      "test",
      "start",
      "backend",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Backend");
  });

  it("errors when explicit project not found", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "nonexistent",
        "--no-dashboard",
        "--no-orchestrator",
      ]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("not found");
  });

  it("errors when multiple projects and no arg", async () => {
    // Non-interactive callers get an error instead of a prompt
    mockIsHumanCaller.mockReturnValue(false);

    mockConfigRef.current = makeConfig({
      frontend: makeProject({ name: "Frontend" }),
      backend: makeProject({ name: "Backend" }),
    });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Multiple projects");
  });

  it("errors when no projects configured", async () => {
    mockConfigRef.current = makeConfig({});

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("No projects configured");
  });
});

describe("start command — OpenClaw preflight", () => {
  it("warns when OpenClaw is configured but offline", async () => {
    mockConfigRef.current = {
      ...makeConfig({ "my-app": makeProject() }),
      notifiers: {
        openclaw: {
          plugin: "openclaw",
          url: "http://127.0.0.1:18789/hooks/agent",
        },
      },
    };
    mockDetectOpenClawInstallation.mockResolvedValue({
      state: "installed-but-stopped",
      gatewayUrl: "http://127.0.0.1:18789",
      probe: { reachable: false, error: "not running" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("OpenClaw is configured but the gateway is not reachable");
  });

  it("suggests setup when OpenClaw is running but not configured", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockDetectOpenClawInstallation.mockResolvedValue({
      state: "running",
      gatewayUrl: "http://127.0.0.1:18789",
      probe: { reachable: true, httpStatus: 200 },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("ao setup openclaw");
  });
});

// ---------------------------------------------------------------------------
// URL detection — `ao start <url>` triggers handleUrlStart
// ---------------------------------------------------------------------------

describe("start command — URL argument", () => {
  it("reuses existing clone and generates config", async () => {
    const repoDir = join(tmpDir, "DevOS");
    createFakeRepo(repoDir, "https://github.com/ComposioHQ/DevOS.git", {
      "package.json": "{}",
      "pnpm-lock.yaml": "",
    });
    mockCwd(tmpDir);

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/ComposioHQ/DevOS",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    // Config should have been generated
    expect(existsSync(join(repoDir, "agent-orchestrator.yaml"))).toBe(true);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Reusing existing clone");
    expect(output).toContain("Startup complete");
  });

  it("clones repo via gh when gh auth is available", async () => {
    const repoDir = join(tmpDir, "my-app");
    mockCwd(tmpDir);

    // gh auth status succeeds
    mockExecSilent.mockResolvedValue("Logged in");

    mockExec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "repo" && args[1] === "clone") {
        createFakeRepo(repoDir, "https://github.com/owner/my-app.git", {
          "Cargo.toml": "",
        });
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/owner/my-app",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    expect(mockExec).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/my-app", repoDir, "--", "--depth", "1"],
      expect.anything(),
    );

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Startup complete");
  });

  it("falls back to git clone when gh is unavailable", async () => {
    const repoDir = join(tmpDir, "my-app");
    mockCwd(tmpDir);

    // gh auth status fails (not installed or not logged in)
    mockExecSilent.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "git" && args[0] === "--version") return "git version 2.43.0";
      if (cmd === "tmux" && args[0] === "-V") return "tmux 3.4";
      if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return null;
      return null;
    });

    mockExec.mockImplementation(async (cmd: string, args: string[]) => {
      // SSH attempt fails
      if (cmd === "git" && args[0] === "clone" && args[3]?.startsWith("git@")) {
        throw new Error("Permission denied (publickey)");
      }
      // HTTPS fallback succeeds
      if (cmd === "git" && args[0] === "clone") {
        createFakeRepo(repoDir, "https://github.com/owner/my-app.git", {
          "Cargo.toml": "",
        });
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/owner/my-app",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    // Should have tried SSH first, then HTTPS
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "git@github.com:owner/my-app.git", repoDir],
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "https://github.com/owner/my-app.git", repoDir],
      expect.anything(),
    );

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Startup complete");
  });

  it("uses existing config when repo already has agent-orchestrator.yaml", async () => {
    const repoDir = join(tmpDir, "configured-app");
    createFakeRepo(repoDir, "https://github.com/owner/configured-app.git");
    mockCwd(tmpDir);

    writeFileSync(
      join(repoDir, "agent-orchestrator.yaml"),
      [
        "port: 4000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: [desktop]",
        "projects:",
        "  configured-app:",
        "    name: Configured App",
        "    repo: owner/configured-app",
        `    path: ${repoDir}`,
        "    defaultBranch: main",
        "    sessionPrefix: ca",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/owner/configured-app",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Using existing config");
    expect(output).toContain("Configured App");
  });

  it("resolves correct project when existing config has multiple projects", async () => {
    const repoDir = join(tmpDir, "multi-proj");
    createFakeRepo(repoDir, "https://github.com/org/multi-proj.git");
    mockCwd(tmpDir);

    writeFileSync(
      join(repoDir, "agent-orchestrator.yaml"),
      [
        "port: 4000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: [desktop]",
        "projects:",
        "  frontend:",
        "    name: Frontend",
        "    repo: org/other-repo",
        `    path: ${repoDir}/frontend`,
        "    defaultBranch: main",
        "    sessionPrefix: fe",
        "  multi-proj:",
        "    name: Multi Proj",
        "    repo: org/multi-proj",
        `    path: ${repoDir}`,
        "    defaultBranch: main",
        "    sessionPrefix: mp",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/org/multi-proj",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    // Should pick "Multi Proj" by matching repo field, not error with "Multiple projects"
    expect(output).toContain("Multi Proj");
    expect(output).toContain("Startup complete");
  });

  it("fails on clone error with descriptive message", async () => {
    mockCwd(tmpDir);
    mockExec.mockRejectedValue(new Error("fatal: repository not found"));

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "https://github.com/owner/nonexistent",
        "--no-dashboard",
        "--no-orchestrator",
      ]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Failed to clone");
  });
});

describe("start command — non-interactive install safety", () => {
  function hasPrivilegedInstallAttempt(): boolean {
    return mockExec.mock.calls.some((call) => {
      const cmd = String(call[0]);
      const args = Array.isArray(call[1]) ? (call[1] as string[]) : [];
      const joined = `${cmd} ${args.join(" ")}`;
      return joined.includes(" install ") && (cmd === "sudo" || cmd === "brew" || cmd === "winget");
    });
  }

  it("does not auto-install tmux when missing in non-interactive mode", async () => {
    mockIsHumanCaller.mockReturnValue(false);

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockExecSilent.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "git" && args[0] === "--version") return "git version 2.43.0";
      if (cmd === "tmux" && args[0] === "-V") return null;
      if (cmd === "gh" && args[0] === "--version") return null;
      if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return null;
      return null;
    });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    expect(hasPrivilegedInstallAttempt()).toBe(false);
    expect(mockExec.mock.calls.some((call) => String(call[0]) === "tmux")).toBe(false);
  });

  it("does not auto-install git when missing in non-interactive URL start", async () => {
    mockIsHumanCaller.mockReturnValue(false);

    mockCwd(tmpDir);
    mockExecSilent.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "git" && args[0] === "--version") return null;
      if (cmd === "tmux" && args[0] === "-V") return "tmux 3.4";
      if (cmd === "gh" && args[0] === "--version") return null;
      if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return null;
      return null;
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "https://github.com/owner/nonexistent",
        "--no-dashboard",
        "--no-orchestrator",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(hasPrivilegedInstallAttempt()).toBe(false);
    expect(
      mockExec.mock.calls.some((call) => {
        const cmd = String(call[0]);
        const args = Array.isArray(call[1]) ? (call[1] as string[]) : [];
        return cmd === "git" && args[0] === "clone";
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitForPortAndOpen — port polling logic
// ---------------------------------------------------------------------------

describe("start command — browser open waits for port", () => {
  it("calls waitForPortAndOpen with orchestrator URL and AbortSignal", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Mock findWebDir to return tmpDir and create package.json for existsSync
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    // No existing orchestrators on disk → spawnOrchestrator runs and returns
    // a numbered id which must end up in the auto-opened browser URL.
    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      projectId: "my-app",
      status: "working",
      activity: "active",
      metadata: { role: "orchestrator" },
    });

    await program.parseAsync(["node", "test", "start"]);

    // waitForPortAndOpen should have been called with orchestrator URL and AbortSignal
    expect(mockWaitForPortAndOpen).toHaveBeenCalledTimes(1);
    const args = mockWaitForPortAndOpen.mock.calls[0];
    expect(args[1]).toContain("/projects/my-app/sessions/app-orchestrator");
    expect(args[2]).toBeInstanceOf(AbortSignal);
    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: expect.any(String) }),
      "my-app",
    );
  });

  it("skips browser open and lifecycle with --no-dashboard --no-orchestrator", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
    expect(mockEnsureLifecycleWorker).not.toHaveBeenCalled();
  });

  it("skips browser open but still starts lifecycle with --no-dashboard alone", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: expect.any(String) }),
      "my-app",
    );
  });
});

describe("start command — orchestrator session strategy display", () => {
  function getLoggedOutput(): string {
    return vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
  }

  it("shows reused messaging when strategy is reuse and metadata marks the session reused", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    mockSessionManager.get.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
    });
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
      metadata: { orchestratorSessionReused: "true" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(output).not.toContain("tmux attach -t tmux-session-1");
  });

  it("falls back to attach messaging when strategy is reuse but metadata is missing", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    mockSessionManager.get.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
    });
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(output).not.toContain("reused existing session");
  });

  it.each(["delete", "ignore", "delete-new", "ignore-new", "kill-previous"] as const)(
    "uses ao session attach when strategy is %s and --no-dashboard",
    async (orchestratorSessionStrategy) => {
      mockConfigRef.current = makeConfig({
        "my-app": makeProject({ orchestratorSessionStrategy }),
      });

      mockSessionManager.get.mockResolvedValue({
        id: "app-orchestrator",
        runtimeHandle: { id: "tmux-session-1" },
      });
      mockSessionManager.spawnOrchestrator.mockResolvedValue({
        id: "app-orchestrator",
        runtimeHandle: { id: "tmux-session-1" },
        metadata: { orchestratorSessionReused: "true" },
      });

      await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

      const output = getLoggedOutput();
      expect(output).toContain("ao session attach app-orchestrator");
      expect(output).not.toContain("reused existing session");
    },
  );

  it("handles existing orchestrator sessions by auto-selecting when --no-dashboard", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Return an existing orchestrator session
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-session-existing" },
      },
    ]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-new" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
    expect(output).toContain("ao session attach app-orchestrator");
  });

  it("restores the latest restorable orchestrator when tmux is gone", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    const now = new Date();
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now.getTime() - 1000),
        lifecycle: {
          version: 2,
          session: {
            kind: "orchestrator",
            state: "working",
            reason: "task_in_progress",
            startedAt: now.toISOString(),
            completedAt: null,
            terminatedAt: null,
            lastTransitionAt: now.toISOString(),
          },
          pr: {
            state: "none",
            reason: "not_created",
            number: null,
            url: null,
            lastObservedAt: null,
          },
          runtime: {
            state: "missing",
            reason: "tmux_missing",
            lastObservedAt: now.toISOString(),
            handle: null,
            tmuxName: "tmux-old-1",
          },
        },
      },
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: now,
        lifecycle: {
          version: 2,
          session: {
            kind: "orchestrator",
            state: "working",
            reason: "task_in_progress",
            startedAt: now.toISOString(),
            completedAt: null,
            terminatedAt: null,
            lastTransitionAt: now.toISOString(),
          },
          pr: {
            state: "none",
            reason: "not_created",
            number: null,
            url: null,
            lastObservedAt: null,
          },
          runtime: {
            state: "missing",
            reason: "tmux_missing",
            lastObservedAt: now.toISOString(),
            handle: null,
            tmuxName: "tmux-old-2",
          },
        },
      },
    ]);
    mockSessionManager.restore.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-restored-2" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(mockSessionManager.restore).toHaveBeenCalledWith("app-orchestrator");
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });

  it("navigates directly to session page when one existing orchestrator found with dashboard enabled", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Mock findWebDir and port availability for dashboard-enabled test
    const webDir = await import("../../src/lib/web-dir.js");
    vi.mocked(webDir.findWebDir).mockReturnValue(tmpDir);
    vi.mocked(webDir.isPortAvailable).mockResolvedValue(true);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = {
      on: vi.fn(),
      kill: vi.fn(),
      emit: vi.fn(),
    };
    mockSpawn.mockReturnValue(fakeDashboard);

    // Return a single existing orchestrator session
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-session-existing" },
      },
    ]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-new" },
    });

    await program.parseAsync(["node", "test", "start"]);

    const output = getLoggedOutput();
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
    expect(output).toContain("http://localhost:3000/projects/my-app/sessions/app-orchestrator");
    expect(output).not.toContain("tmux attach");
  });

  it("opens orchestrator selection page when multiple existing orchestrators found with dashboard enabled and reuse is explicit", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    // Mock findWebDir
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = {
      on: vi.fn(),
      kill: vi.fn(),
      emit: vi.fn(),
    };
    mockSpawn.mockReturnValue(fakeDashboard);

    const now = new Date();
    // Return two existing orchestrator sessions
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now.getTime() - 1000),
        runtimeHandle: { id: "tmux-session-1" },
      },
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: now,
        runtimeHandle: { id: "tmux-session-2" },
      },
    ]);

    await program.parseAsync(["node", "test", "start"]);

    const output = getLoggedOutput();
    expect(output).toContain("/projects/my-app/sessions/app-orchestrator");

    expect(mockWaitForPortAndOpen).toHaveBeenCalledTimes(1);
    const args = mockWaitForPortAndOpen.mock.calls[0];
    expect(args[1]).toContain("/projects/my-app/sessions/app-orchestrator");

    // Should NOT spawn a new orchestrator when existing ones exist
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });

  // ----- Issue #1048: stable orchestrator reuse -----------------------------
  // The next block of tests pins down the new lookup contract that runStartup
  // must follow when deciding whether to reuse, restore, or spawn fresh.

  it("creates the canonical orchestrator when only numbered legacy orchestrators exist", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    // Numbered orchestrators are legacy/stale and should not be restored as
    // the main orchestrator.
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator-3",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-session-3" },
      },
    ]);
    mockSessionManager.restore.mockResolvedValue({
      id: "app-orchestrator",
      projectId: "my-app",
      status: "spawning",
      activity: "active",
      metadata: { role: "orchestrator" },
      lastActivityAt: new Date(),
      runtimeHandle: { id: "tmux-session-3" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockSessionManager.restore).not.toHaveBeenCalled();
    expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledTimes(1);

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(output).not.toContain("(restored)");
  });

  it("ignores stale bare {projectId}-orchestrator records that lack role metadata", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Legacy bare-named record from a pre-numbered AO version with no role
    // metadata — must NOT be treated as an orchestrator, so spawnOrchestrator
    // still gets called and the user gets a fresh numbered id.
    mockSessionManager.list.mockResolvedValue([
      {
        id: "my-app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: {},
        lastActivityAt: new Date(),
        runtimeHandle: null,
      },
    ]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      projectId: "my-app",
      status: "working",
      activity: "active",
      metadata: { role: "orchestrator" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.restore).not.toHaveBeenCalled();

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(output).not.toContain("/sessions/my-app-orchestrator");
  });

  it("prefers a live orchestrator over a more-recently-active restorable one", async () => {
    // Regression guard for PR #1075 review comment: an earlier version of
    // runStartup merged live + restorable into one bucket and sorted by
    // lastActivityAt, which could pick a newer *killed* record over an older
    // but still-running one. sm.restore() would then spin up the killed
    // record while the live one kept running, leaving two orchestrators
    // alive. The fix prefers live unconditionally.
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    const now = Date.now();
    mockSessionManager.list.mockResolvedValue([
      // Live but older — this is the one we must pick.
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now - 60_000),
        runtimeHandle: { id: "tmux-2" },
      },
      // Killed but newer — the old buggy sort would have picked this one.
      {
        id: "app-orchestrator-3",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now),
        runtimeHandle: { id: "tmux-3" },
      },
    ]);

    await program.parseAsync(["node", "test", "start"]);

    // The live -2 is reused in place; the killed -3 is NOT restored.
    expect(mockSessionManager.restore).not.toHaveBeenCalled();
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();

    const output = getLoggedOutput();
    expect(output).toContain("/projects/my-app/sessions/app-orchestrator");
    expect(output).not.toContain("/projects/my-app/sessions/app-orchestrator-3");
  });

  it("reuses the most-recently-active live orchestrator when multiple are running", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    const now = Date.now();
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now - 30_000),
        runtimeHandle: { id: "tmux-1" },
      },
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now),
        runtimeHandle: { id: "tmux-2" },
      },
    ]);

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
    expect(mockSessionManager.restore).not.toHaveBeenCalled();

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
  });

  it("fails and cleans up dashboard when orchestrator setup throws", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Mock findWebDir
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = {
      on: vi.fn(),
      kill: vi.fn(),
      emit: vi.fn(),
    };
    mockSpawn.mockReturnValue(fakeDashboard);

    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.spawnOrchestrator.mockRejectedValue(new Error("Spawn failed"));

    await expect(program.parseAsync(["node", "test", "start"])).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Failed to setup orchestrator: Spawn failed");

    // Should have killed the dashboard
    expect(fakeDashboard.kill).toHaveBeenCalled();
  });

  it("reports startup lock acquisition failures through the normal CLI error path", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockAcquireStartupLock.mockRejectedValueOnce(
      new Error("Could not acquire startup lock (/tmp/startup.lock)"),
    );

    await expect(program.parseAsync(["node", "test", "start"])).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Could not acquire startup lock (/tmp/startup.lock)");
    expect(mockIsAlreadyRunning).not.toHaveBeenCalled();
  });

  it("releases the startup lock before exiting on startup failures", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    const releaseStartupLock = vi.fn();
    mockAcquireStartupLock.mockResolvedValueOnce(releaseStartupLock);
    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.spawnOrchestrator.mockRejectedValue(new Error("Spawn failed"));

    await expect(program.parseAsync(["node", "test", "start"])).rejects.toThrow("process.exit(1)");

    expect(releaseStartupLock).toHaveBeenCalledTimes(1);
  });

  it("fails and cleans up dashboard when sm.restore throws on a killed orchestrator", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = { on: vi.fn(), kill: vi.fn(), emit: vi.fn() };
    mockSpawn.mockReturnValue(fakeDashboard);

    // Only candidate is restorable. sm.restore throws — runStartup must
    // surface the error, kill the dashboard, and never fall through to
    // spawnOrchestrator (which would silently allocate a fresh -N).
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-3" },
      },
    ]);
    mockSessionManager.restore.mockRejectedValue(new Error("workspace gone"));

    await expect(program.parseAsync(["node", "test", "start"])).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Failed to setup orchestrator");
    expect(errors).toContain("workspace gone");

    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
    expect(fakeDashboard.kill).toHaveBeenCalled();
  });

  it("opens the bare dashboard URL when --no-orchestrator skips the orchestrator block", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    await program.parseAsync(["node", "test", "start", "--no-orchestrator"]);

    // Without an orchestrator id, the auto-open URL falls back to the dashboard
    // root rather than the legacy phantom `/sessions/${prefix}-orchestrator` path.
    expect(mockWaitForPortAndOpen).toHaveBeenCalledTimes(1);
    const args = mockWaitForPortAndOpen.mock.calls[0];
    expect(args[1]).toBe("http://localhost:3000");
    expect(args[1]).not.toContain("/sessions/");
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ao stop
// ---------------------------------------------------------------------------

describe("stop command", () => {
  /** Helper: mock exec to simulate a dashboard process on a given port. */
  function mockDashboardOnPort(dashboardPort: number, pid = "12345"): void {
    mockExec.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "kill") return { stdout: "", stderr: "" };
      if (cmd === "ps") return { stdout: "node /fake/web/dist-server/start-all.js", stderr: "" };
      if (cmd === "lsof") {
        const portArg = args.find((a) => a.startsWith(":"));
        if (portArg === `:${dashboardPort}`) return { stdout: pid, stderr: "" };
      }
      throw new Error("no process");
    });
  }

  it("stops the actual numbered orchestrator session and dashboard", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    // Issue #1048: ao stop must look up the real numbered orchestrator id
    // (e.g. app-orchestrator-3) via sm.list — never the phantom `${prefix}-orchestrator`.
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator-3",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-3" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue(undefined);
    mockDashboardOnPort(3000);

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-orchestrator-3", {
      purgeOpenCode: false,
    });
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Orchestrator stopped");
    expect(output).toContain("app-orchestrator-3");
  });

  it("kills the most-recently-active orchestrator when multiple exist", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    const now = Date.now();
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now - 10_000),
        runtimeHandle: { id: "tmux-1" },
      },
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now),
        runtimeHandle: { id: "tmux-2" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-orchestrator", {
      purgeOpenCode: false,
    });
  });

  it("handles missing orchestrator session gracefully", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([]);
    mockExec.mockRejectedValue(new Error("no process"));

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("No running orchestrator session found");
  });

  it("passes purge flag when stopping orchestrator with --purge-session", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-1" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue(undefined);
    mockDashboardOnPort(3000);

    await program.parseAsync(["node", "test", "stop", "--purge-session"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-orchestrator", {
      purgeOpenCode: true,
    });
  });

  it("finds orphaned dashboard on a reassigned port via port scan", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.get.mockResolvedValue({ id: "app-orchestrator", status: "running" });
    mockSessionManager.kill.mockResolvedValue(undefined);
    // Port 3000 has nothing, but port 3001 has the orphaned dashboard
    mockDashboardOnPort(3001, "99999");

    await program.parseAsync(["node", "test", "stop"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("was on port 3001");
  });

  it("skips non-dashboard processes during port scan", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.get.mockResolvedValue({ id: "app-orchestrator", status: "running" });
    mockSessionManager.kill.mockResolvedValue(undefined);
    // Port 3000 has nothing, port 3001 has an unrelated process,
    // port 3002 has the actual dashboard
    mockExec.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "kill") return { stdout: "", stderr: "" };
      if (cmd === "ps") {
        const pid = args[1];
        if (pid === "11111") return { stdout: "python -m http.server 3001", stderr: "" };
        if (pid === "22222") return { stdout: "node /fake/web/dist-server/start-all.js", stderr: "" };
        return { stdout: "", stderr: "" };
      }
      if (cmd === "lsof") {
        const portArg = args.find((a) => a.startsWith(":"));
        if (portArg === ":3001") return { stdout: "11111", stderr: "" };
        if (portArg === ":3002") return { stdout: "22222", stderr: "" };
      }
      throw new Error("no process");
    });

    await program.parseAsync(["node", "test", "stop"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    // Should skip port 3001 (python) and find the dashboard on 3002
    expect(output).toContain("was on port 3002");
  });

  it("only kills dashboard PIDs when port has mixed processes", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.get.mockResolvedValue({ id: "app-orchestrator", status: "running" });
    mockSessionManager.kill.mockResolvedValue(undefined);
    // Port 3000 has two processes: a dashboard and an unrelated sidecar
    mockExec.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "kill") {
        // Only the dashboard PID should be killed, not the sidecar
        expect(args).toEqual(["11111"]);
        return { stdout: "", stderr: "" };
      }
      if (cmd === "ps") {
        const pid = args[1];
        if (pid === "11111") return { stdout: "node /fake/web/dist-server/start-all.js", stderr: "" };
        if (pid === "22222") return { stdout: "nginx: worker process", stderr: "" };
        return { stdout: "", stderr: "" };
      }
      if (cmd === "lsof") {
        const portArg = args.find((a) => a.startsWith(":"));
        if (portArg === ":3000") return { stdout: "11111\n22222", stderr: "" };
      }
      throw new Error("no process");
    });

    await program.parseAsync(["node", "test", "stop"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Dashboard stopped");
  });
});

// ---------------------------------------------------------------------------
// autoCreateConfig — config generation defaults
// ---------------------------------------------------------------------------

describe("start command — autoCreateConfig", () => {
  it("generates config with empty notifiers array (no desktop notifier added by default)", async () => {
    const { detectEnvironment } = await import("../../src/lib/detect-env.js");
    vi.mocked(detectEnvironment).mockResolvedValue({
      isGitRepo: true,
      gitRemote: null,
      ownerRepo: null,
      currentBranch: "main",
      defaultBranch: "main",
      hasTmux: true,
      hasGh: false,
      ghAuthed: false,
      hasLinearKey: false,
      hasSlackWebhook: false,
    });

    const { detectProjectType } = await import("../../src/lib/project-detection.js");
    vi.mocked(detectProjectType).mockReturnValue({ languages: [], frameworks: [] });

    const { detectAvailableAgents, detectAgentRuntime } = await import("../../src/lib/detect-agent.js");
    vi.mocked(detectAvailableAgents).mockResolvedValue([]);
    vi.mocked(detectAgentRuntime).mockResolvedValue("claude-code");

    const { findFreePort } = await import("../../src/lib/web-dir.js");
    vi.mocked(findFreePort).mockResolvedValue(3000);

    // start.ts uses `import { cwd } from "node:process"` which is intercepted
    // by the node:process mock defined at the top of this file.
    mockProcessCwd.mockReturnValue(tmpDir);

    // Non-interactive — skip the repo prompt (no ownerRepo detected)
    const callerContext = await import("../../src/lib/caller-context.js");
    vi.spyOn(callerContext, "isHumanCaller").mockReturnValue(false);

    await createConfigOnly();

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as { defaults?: { notifiers?: unknown[] } };
    expect(parsed.defaults?.notifiers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Already-running detection (moved before config mutation)
// ---------------------------------------------------------------------------

describe("start command — already-running detection", () => {
  it("exits immediately for non-TTY caller when AO is already running", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockIsHumanCaller.mockReturnValue(false);

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // process.exit(0) throws in tests, caught by the action's catch block which calls exit(1)
    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    // Verify the already-running message was printed (not a config error)
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");
    expect(output).toContain("PID: 9999");
  });

  it("exits when human caller selects 'quit'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockPromptSelect.mockResolvedValue("quit");

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");
  });

  it("exits when human caller selects 'open'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockPromptSelect.mockResolvedValue("open");

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");
  });

  it("kills existing process and continues when human caller selects 'restart'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockWaitForExit.mockResolvedValue(true);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    mockPromptSelect.mockResolvedValue("restart");

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // After restart the startup flow continues — it may succeed or fail
    // depending on infrastructure mocks, so we just verify the restart actions
    try {
      await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);
    } catch {
      // Startup after restart may throw — that's OK for this test
    }

    expect(killSpy).toHaveBeenCalledWith(9999, "SIGTERM");
    expect(mockUnregister).toHaveBeenCalled();

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Stopped existing instance");

    killSpy.mockRestore();
  });

  it("creates new orchestrator entry when human caller selects 'new'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockPromptSelect.mockResolvedValue("new");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      configPath,
      yamlStringify(
        {
          defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
          projects: {
            "my-app": {
              name: "My App",
              repo: "org/my-app",
              path: join(tmpDir, "main-repo"),
              defaultBranch: "main",
              sessionPrefix: "app",
            },
          },
        },
        { indent: 2 },
      ),
    );

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    (mockConfigRef.current as Record<string, unknown>).configPath = configPath;

    // After "new" the startup flow continues — it may fail on infrastructure
    try {
      await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);
    } catch {
      // Startup may throw — that's OK for this test
    }

    // Verify a new orchestrator entry was added to the YAML
    const updatedContent = readFileSync(configPath, "utf-8");
    const updatedConfig = parseYaml(updatedContent) as { projects: Record<string, unknown> };
    const projectKeys = Object.keys(updatedConfig.projects);
    expect(projectKeys.length).toBe(2);
    expect(projectKeys).toContain("my-app");
    // The new entry should have a suffix like "my-app-xxxx"
    const newKey = projectKeys.find((k) => k !== "my-app");
    expect(newKey).toMatch(/^my-app-/);
  });

  it("does not mutate YAML when non-TTY caller detects already running (path arg)", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockIsHumanCaller.mockReturnValue(false);

    const repoDir = join(tmpDir, "some-project");
    createFakeRepo(repoDir, "https://github.com/org/some-project.git");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    const originalYaml = yamlStringify(
      {
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {
          "my-app": {
            name: "My App",
            repo: "org/my-app",
            path: join(tmpDir, "main-repo"),
            defaultBranch: "main",
            sessionPrefix: "app",
          },
        },
      },
      { indent: 2 },
    );
    writeFileSync(configPath, originalYaml);

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockCwd(tmpDir);

    // process.exit(0) throws, caught by catch block which calls exit(1)
    await expect(
      program.parseAsync(["node", "test", "start", repoDir, "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    // Verify the already-running message was printed
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");

    // YAML should be unchanged — no duplicate entry added
    const afterYaml = readFileSync(configPath, "utf-8");
    expect(afterYaml).toBe(originalYaml);
  });
});

// ---------------------------------------------------------------------------
// addProjectToConfig — path-based deduplication
// ---------------------------------------------------------------------------

describe("start command — path-based deduplication in addProjectToConfig", () => {
  it("skips addProjectToConfig when path arg matches an existing project", async () => {
    // Pass a local path that's already registered in config.
    // The path-argument branch should find the existing entry and skip addProjectToConfig.
    const repoDir = join(tmpDir, "my-app");
    createFakeRepo(repoDir, "https://github.com/org/my-app.git");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      configPath,
      yamlStringify(
        {
          defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
          projects: {
            "my-app": {
              name: "My App",
              repo: "org/my-app",
              path: repoDir,
              defaultBranch: "main",
              sessionPrefix: "app",
            },
          },
        },
        { indent: 2 },
      ),
    );

    // Set AO_CONFIG_PATH so findConfigFile() finds our config in the path-arg branch
    const origEnv = process.env["AO_CONFIG_PATH"];
    process.env["AO_CONFIG_PATH"] = configPath;

    try {
      // Pass repoDir as a local path arg — enters the path-argument branch
      await program.parseAsync([
        "node",
        "test",
        "start",
        repoDir,
        "--no-dashboard",
        "--no-orchestrator",
      ]);

      // Verify no duplicate entry was created in the YAML
      const content = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content) as { projects: Record<string, unknown> };
      expect(Object.keys(parsed.projects)).toEqual(["my-app"]);
    } finally {
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
    }
  });

  it("deduplicates via addProjectToConfig when path exists under a different name", async () => {
    // Register a project under name "old-name" pointing to repoDir.
    // Then pass repoDir as a path arg with a config that doesn't match by name.
    // addProjectToConfig's path dedup should return "old-name" without creating a duplicate.
    const repoDir = join(tmpDir, "new-project");
    createFakeRepo(repoDir, "https://github.com/org/new-project.git");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      configPath,
      yamlStringify(
        {
          defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
          projects: {
            "old-name": {
              name: "Old Name",
              repo: "org/new-project",
              path: repoDir,
              defaultBranch: "main",
              sessionPrefix: "old",
            },
          },
        },
        { indent: 2 },
      ),
    );

    // Set AO_CONFIG_PATH so findConfigFile() finds our config
    const origEnv = process.env["AO_CONFIG_PATH"];
    process.env["AO_CONFIG_PATH"] = configPath;

    try {
      // Pass repoDir as path arg. The path-argument branch's path-match check
      // at lines 1304-1311 finds "old-name" by path and skips addProjectToConfig.
      // If that outer check were removed, addProjectToConfig's own dedup (lines 656-665)
      // would catch it. Either way, no duplicate entry should be created.
      await program.parseAsync([
        "node",
        "test",
        "start",
        repoDir,
        "--no-dashboard",
        "--no-orchestrator",
      ]);

      const content = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content) as { projects: Record<string, unknown> };
      expect(Object.keys(parsed.projects)).toEqual(["old-name"]);
    } finally {
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
    }
  });
});

describe("start command — global registry mutations", () => {
  it("adds a project to the global registry and writes behavior to the repo-local config", async () => {
    const currentRepoDir = join(tmpDir, "current");
    const addedRepoDir = join(tmpDir, "added");
    createFakeRepo(currentRepoDir, "https://github.com/org/current.git");
    createFakeRepo(addedRepoDir, "https://github.com/org/added.git");
    writeFileSync(join(addedRepoDir, ".git", "refs", "remotes", "origin", "master"), "abc\n");

    const localCurrentConfigPath = join(currentRepoDir, "agent-orchestrator.yaml");
    writeFileSync(localCurrentConfigPath, "agent: claude-code\n");

    const globalConfigPath = join(tmpDir, "config.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      globalConfigPath,
      yamlStringify(
        {
          defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
          projects: {
            current: {
              projectId: "current",
              path: currentRepoDir,
              storageKey: "current-storage",
              defaultBranch: "main",
              displayName: "Current",
              sessionPrefix: "current",
            },
          },
        },
        { indent: 2 },
      ),
    );
    mockConfigRef.current = makeConfig({
      current: makeProject({ name: "Current", path: currentRepoDir, sessionPrefix: "current" }),
    });
    (mockConfigRef.current as Record<string, unknown>).configPath = globalConfigPath;

    const origEnv = process.env["AO_CONFIG_PATH"];
    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    process.env["AO_CONFIG_PATH"] = globalConfigPath;
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;

    const shell = await import("../../src/lib/shell.js");
    vi.mocked(shell.git).mockImplementation(async (args: string[], workingDir?: string) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir" && workingDir === addedRepoDir) return ".git";
      if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin" && workingDir === addedRepoDir) {
        return "https://github.com/org/added.git";
      }
      if (args[0] === "symbolic-ref" && workingDir === addedRepoDir) return "refs/remotes/origin/master";
      if (args[0] === "rev-parse" && args[1] === "--verify" && workingDir === addedRepoDir) return "abc";
      return null;
    });

    try {
      try {
        await program.parseAsync([
          "node",
          "test",
          "start",
          addedRepoDir,
          "--no-dashboard",
          "--no-orchestrator",
        ]);
      } catch (error) {
        const loggedErrors = vi
          .mocked(console.error)
          .mock.calls.map((call) => call.join(" "))
          .join("\n");
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${loggedErrors}`,
          { cause: error },
        );
      }

      const globalConfig = parseYaml(readFileSync(globalConfigPath, "utf-8")) as {
        projects: Record<string, Record<string, unknown>>;
      };
      expect(globalConfig.projects["added"]).toMatchObject({
        path: realpathSync(addedRepoDir),
        defaultBranch: "master",
        sessionPrefix: "add",
      });
      expect(globalConfig.projects["added"]).not.toHaveProperty("agentRules");

      const localAddedConfig = readFileSync(join(addedRepoDir, "agent-orchestrator.yaml"), "utf-8");
      expect(localAddedConfig).not.toContain("projects:");
    } finally {
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
    }
  });

  it("writes interactive agent overrides to the repo-local config when using the global registry", async () => {
    const repoDir = join(tmpDir, "current");
    createFakeRepo(repoDir, "https://github.com/org/current.git");

    const localConfigPath = join(repoDir, "agent-orchestrator.yaml");
    writeFileSync(localConfigPath, "agent: claude-code\n");

    const globalConfigPath = join(tmpDir, "config.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      globalConfigPath,
      yamlStringify(
        {
          defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
          projects: {
            current: {
              projectId: "current",
              path: repoDir,
              storageKey: "current-storage",
              defaultBranch: "main",
              displayName: "Current",
              sessionPrefix: "current",
            },
          },
        },
        { indent: 2 },
      ),
    );
    mockConfigRef.current = makeConfig({
      current: makeProject({ name: "Current", path: repoDir, sessionPrefix: "current" }),
    });
    (mockConfigRef.current as Record<string, unknown>).configPath = globalConfigPath;

    const origEnv = process.env["AO_CONFIG_PATH"];
    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    process.env["AO_CONFIG_PATH"] = globalConfigPath;
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;

    const detectAgent = await import("../../src/lib/detect-agent.js");
    vi.mocked(detectAgent.detectAvailableAgents).mockResolvedValue([
      { name: "codex", displayName: "Codex" },
      { name: "opencode", displayName: "OpenCode" },
    ]);
    mockPromptSelect.mockResolvedValueOnce("codex").mockResolvedValueOnce("opencode");
    const originalStdinTty = process.stdin.isTTY;
    const originalStdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    try {
      await program.parseAsync([
        "node",
        "test",
        "start",
        "--interactive",
        "--no-dashboard",
        "--no-orchestrator",
      ]);

      const localConfig = readFileSync(localConfigPath, "utf-8");
      expect(localConfig).toContain("orchestrator:");
      expect(localConfig).toContain("agent: codex");
      expect(localConfig).toContain("worker:");
      expect(localConfig).toContain("agent: opencode");

      const globalConfig = readFileSync(globalConfigPath, "utf-8");
      expect(globalConfig).not.toContain("orchestrator:");
      expect(globalConfig).not.toContain("worker:");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: originalStdinTty, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: originalStdoutTty, configurable: true });
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
    }
  });
});
