import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createActivitySignal,
  type Session,
  type RuntimeHandle,
  type AgentLaunchConfig,
  type ProjectConfig,
} from "@aoagents/ao-core";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock homedir() so kimiShareDir() points at a per-test temp dir.
// fakeHome is assigned in beforeEach.
// ---------------------------------------------------------------------------
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

// ---------------------------------------------------------------------------
// Core activity-log mocks — only the shared helpers, not fs primitives.
// ---------------------------------------------------------------------------
const { mockReadLastActivityEntry, mockRecordTerminalActivity, mockSetupPathWrapperWorkspace } =
  vi.hoisted(() => ({
    mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
    mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
    mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: mockRecordTerminalActivity,
    setupPathWrapperWorkspace: mockSetupPathWrapperWorkspace,
  };
});

// ---------------------------------------------------------------------------
// child_process mocks — tmux/ps for isProcessRunning, execFileSync for detect.
// ---------------------------------------------------------------------------
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const execFile = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return {
    execFile,
    execFileSync: vi.fn(),
  };
});

import {
  create,
  manifest,
  default as defaultExport,
  detect,
  _resetSessionMatchCache,
} from "./index.js";

// ---------------------------------------------------------------------------
// Kimi on-disk layout helpers — mirrors the real kimi-cli 1.38 storage
// (~/.kimi/sessions/<md5(cwd)>/<session-uuid>/{context,wire}.jsonl).
// ---------------------------------------------------------------------------
function workspaceHash(workspacePath: string): string {
  return createHash("md5").update(workspacePath).digest("hex");
}

function writeKimiSession(
  workspacePath: string,
  sessionId: string,
  opts: { contextAgeMs?: number; wireAgeMs?: number; wireContent?: string } = {},
): string {
  const bucket = join(fakeHome, ".kimi", "sessions", workspaceHash(workspacePath));
  const sessionDir = join(bucket, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const contextPath = join(sessionDir, "context.jsonl");
  const wirePath = join(sessionDir, "wire.jsonl");
  writeFileSync(contextPath, '{"role":"_system_prompt","content":"hello"}\n');
  writeFileSync(
    wirePath,
    opts.wireContent ??
      [
        '{"type":"metadata","protocol_version":"1.9"}',
        '{"timestamp":1776875930,"message":{"type":"TurnBegin","payload":{"user_input":"say hello"}}}',
        '{"timestamp":1776875931,"message":{"type":"TurnEnd","payload":{}}}',
      ].join("\n") + "\n",
  );

  if (opts.contextAgeMs !== undefined) {
    const ts = new Date(Date.now() - opts.contextAgeMs);
    utimesSync(contextPath, ts, ts);
  }
  if (opts.wireAgeMs !== undefined) {
    const ts = new Date(Date.now() - opts.wireAgeMs);
    utimesSync(wirePath, ts, ts);
  }
  return sessionDir;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  // Minimal Session stub; the plugin never reads `lifecycle`.
  const base = {
    id: "kimi-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
  return base as unknown as Session;
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number): RuntimeHandle {
  return { id: "proc-1", runtimeName: "process", data: pid !== undefined ? { pid } : {} };
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "proj",
    repo: "o/r",
    path: "/p",
    defaultBranch: "main",
    sessionPrefix: "p",
    ...overrides,
  };
}

function mockTmuxWithProcess(processName: string, found = true) {
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys005\n", stderr: "" });
    if (cmd === "ps") {
      const line = found ? `  444 ttys005  ${processName}` : "  444 ttys005  zsh";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSessionMatchCache();
  mockReadLastActivityEntry.mockResolvedValue(null);
  mockRecordTerminalActivity.mockResolvedValue(undefined);
  mockSetupPathWrapperWorkspace.mockResolvedValue(undefined);
  fakeHome = mkdtempSync(join(tmpdir(), "kimicode-test-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

// =============================================================================
// Manifest & exports
// =============================================================================
describe("manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "kimicode",
      slot: "agent",
      description: "Agent plugin: Kimi Code CLI (MoonshotAI)",
      version: "0.1.0",
      displayName: "Kimi Code",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("kimicode");
    expect(agent.processName).toBe("kimi");
  });

  it("uses inline prompt delivery (kimi's -p does not exit after prompt)", () => {
    const agent = create();
    expect(agent.promptDelivery === undefined || agent.promptDelivery === "inline").toBe(true);
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });
});

// =============================================================================
// getLaunchCommand
// =============================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("kimi");
  });

  it("adds --yolo when permissions=permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--yolo");
  });

  it("adds --yolo when permissions=auto-edit", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--yolo");
  });

  it("omits --yolo when permissions=suggest", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "suggest" }));
    expect(cmd).not.toContain("--yolo");
  });

  it("passes --model shell-escaped", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "kimi-k2" }));
    expect(cmd).toContain("--model 'kimi-k2'");
  });

  it("passes --agent-file when systemPromptFile is set", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPromptFile: "/tmp/sp.md" }));
    expect(cmd).toContain("--agent-file '/tmp/sp.md'");
  });

  it("passes --prompt inline (kimi's -p is a prompt string, not a mode switch)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "do the thing" }));
    expect(cmd).toContain("--prompt 'do the thing'");
  });

  it("shell-escapes prompts with special characters", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's complicated" }));
    expect(cmd).toContain("--prompt 'it'\\''s complicated'");
  });

  it("passes --agent when config.subagent is set", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ subagent: "okabe" }));
    expect(cmd).toContain("--agent 'okabe'");
  });

  it("combines model + yolo + agent + agent-file + prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        permissions: "permissionless",
        model: "kimi-k2",
        subagent: "default",
        systemPromptFile: "/tmp/sp.md",
        prompt: "Go",
      }),
    );
    expect(cmd).toBe(
      "kimi --yolo --model 'kimi-k2' --agent 'default' --agent-file '/tmp/sp.md' --prompt 'Go'",
    );
  });
});

// =============================================================================
// getEnvironment
// =============================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
  });

  it("sets AO_ISSUE_ID only when provided", () => {
    expect(agent.getEnvironment(makeLaunchConfig()).AO_ISSUE_ID).toBeUndefined();
    expect(agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" })).AO_ISSUE_ID).toBe(
      "GH-42",
    );
  });

  it("prepends ~/.ao/bin to PATH", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toMatch(/\.ao\/bin/);
  });

  it("sets GH_PATH to the preferred gh binary", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["GH_PATH"]).toBe("/usr/local/bin/gh");
  });
});

// =============================================================================
// detectActivity
// =============================================================================
describe("detectActivity", () => {
  const agent = create();

  it("idle for empty/whitespace output", () => {
    expect(agent.detectActivity("")).toBe("idle");
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("idle when generic shell/REPL prompt is visible", () => {
    expect(agent.detectActivity("tokens: 1k\n> ")).toBe("idle");
    expect(agent.detectActivity("tokens: 1k\n$ ")).toBe("idle");
  });

  it("idle when kimi-specific prompt is visible", () => {
    expect(agent.detectActivity("output\nkimi> ")).toBe("idle");
    expect(agent.detectActivity("output\nkimi: ")).toBe("idle");
  });

  it("waiting_input for (Y)es/(N)o confirmations", () => {
    expect(agent.detectActivity("Allow edit to foo.ts?\n(Y)es/(N)o")).toBe("waiting_input");
  });

  it("waiting_input for [y/n] style confirmations", () => {
    expect(agent.detectActivity("Continue? [y/n]")).toBe("waiting_input");
  });

  it("waiting_input for a bare 'approve?' prompt line (not mid-sentence)", () => {
    expect(agent.detectActivity("Run rm -rf build/\napprove?")).toBe("waiting_input");
  });

  it("does NOT match 'approve' in agent narration (false-positive guard)", () => {
    const narration = "I approve of this approach and will proceed.\nReading src/index.ts";
    expect(agent.detectActivity(narration)).toBe("active");
  });

  it("waiting_input for 'Do you want to proceed?' prompts", () => {
    expect(agent.detectActivity("This will modify 3 files.\nDo you want to proceed?")).toBe(
      "waiting_input",
    );
  });

  it("blocked on error: prefix", () => {
    expect(agent.detectActivity("error: failed to parse response\n")).toBe("blocked");
  });

  it("blocked on line-anchored 'failed to authenticate'", () => {
    expect(agent.detectActivity("failed to authenticate with Kimi API\n")).toBe("blocked");
  });

  it("does NOT match 'failed to connect' mid-sentence (false-positive guard)", () => {
    const narration =
      "Earlier I failed to connect on the first try, but the retry worked.\nGenerating code...";
    expect(agent.detectActivity(narration)).toBe("active");
  });

  it("active for ongoing work output", () => {
    expect(agent.detectActivity("Generating code...\nReading src/index.ts")).toBe("active");
  });
});

// =============================================================================
// isProcessRunning
// =============================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when `kimi` is running on the pane TTY", async () => {
    mockTmuxWithProcess("kimi");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when the dot-prefixed shim `.kimi` is running", async () => {
    mockTmuxWithProcess("/usr/local/bin/.kimi");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when invoked as `uv run kimi`", async () => {
    mockTmuxWithProcess("uv run kimi --yolo");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when invoked as `python -m kimi`", async () => {
    mockTmuxWithProcess("python -m kimi --print");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when `kimi` appears only in argv[>0] (not as the executable)", async () => {
    // A user running `cat kimi.log` or `vim ~/.kimi/config.toml` on the pane
    // must NOT count as kimi running.
    mockTmuxWithProcess("cat kimi.log", true);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false for `/usr/bin/vim ~/.kimi/config.toml`", async () => {
    mockTmuxWithProcess("/usr/bin/vim /home/harsh/.kimi/config.toml", true);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when kimi is not on the pane TTY", async () => {
    mockTmuxWithProcess("zsh", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process runtime with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false for process runtime with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(456))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns true for PID that throws EPERM (permission denied ≠ dead)", async () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux gone"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
  });
});

// =============================================================================
// getActivityState — the mandatory 5-step cascade plus ordering + decay
// =============================================================================
describe("getActivityState", () => {
  const agent = create();
  const workspace = "/workspace/test";

  it("1. returns exited when process is not running", async () => {
    mockTmuxWithProcess("zsh", false);
    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("exited");
  });

  it("1b. returns exited when runtimeHandle is null", async () => {
    const result = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(result?.state).toBe("exited");
  });

  it("2. returns waiting_input from AO activity JSONL", async () => {
    mockTmuxWithProcess("kimi");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("waiting_input");
  });

  it("3. returns blocked from AO activity JSONL", async () => {
    mockTmuxWithProcess("kimi");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "blocked", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("blocked");
  });

  it("4. returns active from native signal when session files are fresh", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-abc"); // fresh (age ~ 0)

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("active");
  });

  it("4b. returns ready from native signal when mtime falls in the ready window", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-abc", {
      contextAgeMs: 2 * 60 * 1000,
      wireAgeMs: 2 * 60 * 1000,
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("ready");
  });

  it("4c. returns idle from native signal when mtime is older than readyThreshold", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-abc", {
      contextAgeMs: 10 * 60 * 1000,
      wireAgeMs: 10 * 60 * 1000,
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("idle");
  });

  it("cascade: JSONL waiting_input wins over native signal even when a session dir exists", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-abc"); // would be "active"

    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("waiting_input");
  });

  it("native signal prefers the fresher of context.jsonl vs wire.jsonl mtimes", async () => {
    mockTmuxWithProcess("kimi");
    // wire.jsonl is fresh, context.jsonl is stale → mtime = wire (fresh) → active.
    writeKimiSession(workspace, "sess-abc", {
      contextAgeMs: 10 * 60 * 1000,
      wireAgeMs: 0,
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("active");
  });

  it("picks the most recently modified session UUID when multiple exist in the bucket", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-old", {
      contextAgeMs: 10 * 60 * 1000,
      wireAgeMs: 10 * 60 * 1000,
    });
    writeKimiSession(workspace, "sess-new"); // fresh

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("active");
  });

  it("5. returns active from JSONL entry fallback when native signal is unavailable (fresh entry)", async () => {
    mockTmuxWithProcess("kimi");
    // No ~/.kimi/sessions/<hash>/ dir for this workspace — fakeHome is empty.

    const now = new Date();
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: now.toISOString(), state: "active", source: "terminal" },
      modifiedAt: now,
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("active");
  });

  it("6. returns idle from JSONL entry fallback with age decay (old entry)", async () => {
    mockTmuxWithProcess("kimi");

    const old = new Date(Date.now() - 10 * 60 * 1000);
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: old.toISOString(), state: "active", source: "terminal" },
      modifiedAt: old,
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("idle");
  });

  it("7. returns null when both native signal and JSONL are unavailable", async () => {
    mockTmuxWithProcess("kimi");
    mockReadLastActivityEntry.mockResolvedValueOnce(null);

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result).toBeNull();
  });

  it("returns null when workspacePath is missing (no source of truth)", async () => {
    mockTmuxWithProcess("kimi");
    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: null }),
    );
    expect(result).toBeNull();
  });

  it("resolves symlinked workspace paths before hashing (kimi sees realpath as cwd)", async () => {
    mockTmuxWithProcess("kimi");
    // Create a real target dir + a symlink pointing at it. Kimi's process
    // resolves symlinks via os.getcwd(), so its MD5 bucket is keyed by the
    // realpath. Our plugin must match by realpath too.
    const real = join(fakeHome, "workspaces", "real-project");
    mkdirSync(real, { recursive: true });
    const link = join(fakeHome, "workspaces", "link-to-project");
    symlinkSync(real, link);

    // Write a session under the realpath bucket, then look it up via the
    // symlink path — our resolveWorkspacePath should make them equivalent.
    writeKimiSession(real, "sess-abc");

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: link }),
    );
    expect(result?.state).toBe("active");
  });

  it("falls back to UUID dir mtime when live-signal files aren't written yet (race window)", async () => {
    mockTmuxWithProcess("kimi");
    const bucket = join(fakeHome, ".kimi", "sessions", workspaceHash(workspace));
    // UUID dir exists but context.jsonl / wire.jsonl haven't been created yet.
    // This is the brief window during session creation — we should still
    // report a valid state using the dir mtime, not flicker to "no signal".
    mkdirSync(join(bucket, "empty-session"), { recursive: true });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("active");
  });
});

// =============================================================================
// recordActivity
// =============================================================================
describe("recordActivity", () => {
  const agent = create();

  it("delegates to recordTerminalActivity", async () => {
    await agent.recordActivity!(makeSession(), "kimi is generating");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "kimi is generating",
      expect.any(Function),
    );
  });

  it("is a no-op when workspacePath is null", async () => {
    await agent.recordActivity!(makeSession({ workspacePath: null }), "output");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

// =============================================================================
// getSessionInfo
// =============================================================================
describe("getSessionInfo", () => {
  const agent = create();
  const workspace = "/workspace/test";

  it("returns null when workspacePath is missing", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when no matching kimi session dir exists", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: workspace }))).toBeNull();
  });

  it("returns the session UUID as agentSessionId", async () => {
    writeKimiSession(workspace, "6ec34626-aedf-4659-a061-c5fbfa4cf166");
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info).not.toBeNull();
    expect(info!.agentSessionId).toBe("6ec34626-aedf-4659-a061-c5fbfa4cf166");
    expect(info!.summaryIsFallback).toBe(true);
    expect(info!.cost).toBeUndefined();
  });

  it("extracts the first user input from wire.jsonl as a summary", async () => {
    writeKimiSession(workspace, "sess-abc", {
      wireContent:
        [
          '{"type":"metadata","protocol_version":"1.9"}',
          '{"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":"fix the login bug"}}}',
          '{"timestamp":2,"message":{"type":"TurnEnd","payload":{}}}',
        ].join("\n") + "\n",
    });
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info!.summary).toBe("fix the login bug");
  });

  it("truncates a long user input to 120 chars + ellipsis", async () => {
    const longInput = "A".repeat(200);
    writeKimiSession(workspace, "sess-abc", {
      wireContent:
        [
          '{"type":"metadata","protocol_version":"1.9"}',
          `{"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":"${longInput}"}}}`,
        ].join("\n") + "\n",
    });
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info!.summary).toHaveLength(123);
    expect(info!.summary!.endsWith("...")).toBe(true);
  });

  it("returns null summary when wire.jsonl has no TurnBegin entry", async () => {
    writeKimiSession(workspace, "sess-abc", {
      wireContent: '{"type":"metadata","protocol_version":"1.9"}\n',
    });
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info!.summary).toBeNull();
    expect(info!.agentSessionId).toBe("sess-abc");
  });

  it("skips malformed wire.jsonl lines without crashing", async () => {
    writeKimiSession(workspace, "sess-abc", {
      wireContent:
        [
          "not json at all",
          '{"type":"metadata","protocol_version":"1.9"}',
          '{"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":"recovered"}}}',
        ].join("\n") + "\n",
    });
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info!.summary).toBe("recovered");
  });
});

// =============================================================================
// getRestoreCommand
// =============================================================================
describe("getRestoreCommand", () => {
  const agent = create();
  const workspace = "/workspace/test";

  it("returns null when workspacePath is missing", async () => {
    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: null }),
      makeProject(),
    );
    expect(result).toBeNull();
  });

  it("returns null when no kimi session dir exists", async () => {
    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: workspace }),
      makeProject(),
    );
    expect(result).toBeNull();
  });

  it("uses --resume <session_uuid>", async () => {
    writeKimiSession(workspace, "6ec34626-aedf-4659-a061-c5fbfa4cf166");
    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: workspace }),
      makeProject(),
    );
    expect(result).toBe("kimi --resume '6ec34626-aedf-4659-a061-c5fbfa4cf166'");
  });

  it("passes --yolo and --model from project.agentConfig", async () => {
    writeKimiSession(workspace, "sess-abc");
    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: workspace }),
      makeProject({
        agentConfig: { permissions: "permissionless", model: "kimi-k2" },
      }),
    );
    expect(result).toContain("kimi --resume 'sess-abc'");
    expect(result).toContain("--yolo");
    expect(result).toContain("--model 'kimi-k2'");
  });

  it("picks the most recently modified session UUID when multiple exist", async () => {
    writeKimiSession(workspace, "sess-old", {
      contextAgeMs: 60 * 60 * 1000,
      wireAgeMs: 60 * 60 * 1000,
    });
    writeKimiSession(workspace, "sess-new");

    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: workspace }),
      makeProject(),
    );
    expect(result).toBe("kimi --resume 'sess-new'");
  });
});

// =============================================================================
// setupWorkspaceHooks / postLaunchSetup
// =============================================================================
describe("workspace hooks", () => {
  const agent = create();

  it("setupWorkspaceHooks delegates to setupPathWrapperWorkspace", async () => {
    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/tmp/ao-data", sessionId: "s" });
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("postLaunchSetup is a no-op when workspacePath is null", async () => {
    await agent.postLaunchSetup!(makeSession({ workspacePath: null }));
    expect(mockSetupPathWrapperWorkspace).not.toHaveBeenCalled();
  });

  it("postLaunchSetup installs PATH wrappers", async () => {
    await agent.postLaunchSetup!(makeSession());
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });
});

// =============================================================================
// detect()
// =============================================================================
describe("detect", () => {
  it("returns true when `kimi info` prints the kimi-cli vendor string", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(
      () =>
        "kimi-cli version: 1.38.0\nagent spec versions: 1\n" as unknown as ReturnType<
          typeof execFileSync
        >,
    );
    expect(detect()).toBe(true);
  });

  it("returns true for kimi-code vendor string", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(
      () => "package: kimi-code\n" as unknown as ReturnType<typeof execFileSync>,
    );
    expect(detect()).toBe(true);
  });

  it("returns true when output mentions Moonshot", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(
      () => "moonshot kimi 1.38\n" as unknown as ReturnType<typeof execFileSync>,
    );
    expect(detect()).toBe(true);
  });

  it("returns false when `kimi info` throws (binary missing or unrelated)", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("command not found");
    });
    expect(detect()).toBe(false);
  });

  it("rejects an unrelated `kimi` binary whose output lacks the vendor marker", async () => {
    // E.g. a hypothetical keyboard-input-manager named `kimi` whose output
    // contains plain "kimi" but no kimi-cli / kimi-code / moonshot marker.
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(
      () =>
        "kimi v0.1 — keyboard input manager\n" as unknown as ReturnType<typeof execFileSync>,
    );
    expect(detect()).toBe(false);
  });
});
