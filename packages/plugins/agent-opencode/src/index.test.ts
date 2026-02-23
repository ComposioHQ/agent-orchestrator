import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AgentLaunchConfig,
  RuntimeHandle,
  Session,
  WorkspaceHooksConfig,
} from "@composio/ao-core";

const { mockExecFileAsync, mockExistsSync, mockReadFile, mockWriteFile, mockMkdir, mockHomedir } =
  vi.hoisted(() => ({
    mockExecFileAsync: vi.fn(),
    mockExistsSync: vi.fn(),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(),
    mockHomedir: vi.fn(() => "/mock/home"),
  }));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

import { create, manifest, default as defaultExport } from "./index.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
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
}

function makeTmuxHandle(id = "tmux-1"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number | string): RuntimeHandle {
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

function makeHooksConfig(overrides: Partial<WorkspaceHooksConfig> = {}): WorkspaceHooksConfig {
  return {
    dataDir: "/tmp/ao-data",
    ...overrides,
  };
}

function mockTmuxWithProcess(processName: string, found = true) {
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    if (cmd === "ps") {
      const line = found ? `  789 ttys003  ${processName}` : "  789 ttys003  bash";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error("unexpected"));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHomedir.mockReturnValue("/mock/home");
  mockExistsSync.mockReturnValue(false);
  mockReadFile.mockResolvedValue("");
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "opencode",
      slot: "agent",
      description: "Agent plugin: OpenCode",
      version: "0.1.0",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("opencode");
    expect(agent.processName).toBe("opencode");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("getLaunchCommand", () => {
  const agent = create();

  it("always uses opencode run with --format json and --title", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toContain("opencode run");
    expect(cmd).toContain("--format json");
    expect(cmd).toContain("--title 'sess-1'");
  });

  it("adds prompt and model with shell escaping", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "it's broken", model: "provider/model" }),
    );
    expect(cmd).toContain("run 'it'\\''s broken'");
    expect(cmd).toContain("--model 'provider/model'");
  });

  it("includes --agent from project agentConfig.agent", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          name: "my-project",
          repo: "owner/repo",
          path: "/workspace/repo",
          defaultBranch: "main",
          sessionPrefix: "my",
          agentConfig: { agent: "planner" },
        },
      }),
    );
    expect(cmd).toContain("--agent 'planner'");
  });

  it("includes --dir when project path exists", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toContain("--dir '/workspace/repo'");
  });

  it("prefixes OPENCODE_CONFIG_CONTENT command substitution for systemPromptFile", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/system prompt.txt" }),
    );
    expect(cmd).toContain("OPENCODE_CONFIG_CONTENT=");
    expect(cmd).toContain("$(cat '/tmp/system prompt.txt'");
    expect(cmd).toContain("opencode run");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID and AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));
    expect(env.AO_SESSION_ID).toBe("sess-1");
    expect(env.AO_ISSUE_ID).toBe("GH-42");
  });

  it("sets OPENCODE_CONFIG_CONTENT with inline systemPrompt", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ systemPrompt: "Be strict." }));
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"instructions":["Be strict."]}');
  });

  it("sets marker OPENCODE_CONFIG_CONTENT for systemPromptFile", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ systemPromptFile: "/tmp/sys.txt" }));
    expect(env.OPENCODE_CONFIG_CONTENT).toBe("__AO_SYSTEM_PROMPT_FILE__:/tmp/sys.txt");
  });

  it("sets AO_OPENCODE_PERMISSIONS when permissions=skip", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ permissions: "skip" }));
    expect(env.AO_OPENCODE_PERMISSIONS).toBe("skip");
  });
});

describe("detectActivity", () => {
  const agent = create();
  const detectActivity = Reflect.get(agent as object, "detectActivity") as (
    terminalOutput: string,
  ) => string;

  it("returns idle for empty output", () => {
    expect(detectActivity("")).toBe("idle");
    expect(detectActivity("  \n  ")).toBe("idle");
  });

  it("returns idle for shell prompts", () => {
    expect(detectActivity("output\n$ ")).toBe("idle");
    expect(detectActivity("output\n❯ ")).toBe("idle");
    expect(detectActivity("output\n> ")).toBe("idle");
  });

  it("returns waiting_input for permission-related tail output", () => {
    expect(detectActivity("Need permission\nAllow / Deny\n")).toBe("waiting_input");
    expect(detectActivity("Proceed? (Y)es / (N)o\n")).toBe("waiting_input");
  });

  it("returns active for non-empty non-idle output", () => {
    expect(detectActivity("thinking...\ncalling tool\n")).toBe("active");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when opencode found on tmux pane TTY", async () => {
    mockTmuxWithProcess("opencode");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when opencode not on tmux pane TTY", async () => {
    mockTmuxWithProcess("opencode", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process handle with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("returns false for process handle with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });
});

describe("getActivityState", () => {
  const agent = create();

  it("returns exited when runtime handle is missing", async () => {
    const result = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(result?.state).toBe("exited");
  });

  it("returns exited when process is not running", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const session = makeSession({ runtimeHandle: makeProcessHandle(321) });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
    killSpy.mockRestore();
  });

  it("returns null when no sqlite db exists", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockExistsSync.mockReturnValue(false);
    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(321) }),
      60_000,
    );
    expect(result).toBeNull();
    killSpy.mockRestore();
  });

  it("maps recent user message to active", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockExistsSync.mockImplementation(
      (path: string) => path === "/mock/home/.opencode/opencode.db",
    );
    const nowMs = Date.now();
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ data: '{"role":"user"}', time_updated: nowMs }]),
      stderr: "",
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(123) }),
      300_000,
    );
    expect(result?.state).toBe("active");
    killSpy.mockRestore();
  });

  it("maps recent assistant message to ready", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockExistsSync.mockImplementation(
      (path: string) => path === "/mock/home/.opencode/opencode.db",
    );
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ data: '{"role":"assistant"}', time_updated: Date.now() }]),
      stderr: "",
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(456) }),
      300_000,
    );
    expect(result?.state).toBe("ready");
    killSpy.mockRestore();
  });

  it("maps old messages to idle", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockExistsSync.mockImplementation(
      (path: string) => path === "/mock/home/.opencode/opencode.db",
    );
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ data: '{"role":"user"}', time_updated: 1_000 }]),
      stderr: "",
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(456) }),
      1_000,
    );
    expect(result?.state).toBe("idle");
    killSpy.mockRestore();
  });

  it("returns null gracefully when sqlite command fails", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    mockExistsSync.mockImplementation(
      (path: string) => path === "/mock/home/.opencode/opencode.db",
    );
    mockExecFileAsync.mockRejectedValue(new Error("sqlite3 missing"));

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(789) }),
    );
    expect(result).toBeNull();
    killSpy.mockRestore();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  it("returns null when workspacePath is missing", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when sqlite db is unavailable", async () => {
    mockExistsSync.mockReturnValue(false);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns summary/session id and aggregated cost", async () => {
    mockExistsSync.mockImplementation(
      (path: string) => path === "/mock/home/.opencode/opencode.db",
    );
    mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      const sql = args[2] ?? "";
      if (sql.includes("FROM session")) {
        return Promise.resolve({
          stdout: JSON.stringify([
            { id: "s-123", title: "My OpenCode session", time_updated: Date.now() },
          ]),
          stderr: "",
        });
      }
      return Promise.resolve({
        stdout: JSON.stringify([
          {
            data: JSON.stringify({
              usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 },
              costUSD: 0.05,
            }),
          },
          {
            data: JSON.stringify({ inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.01 }),
          },
        ]),
        stderr: "",
      });
    });

    const result = await agent.getSessionInfo(makeSession());
    expect(result?.summary).toBe("My OpenCode session");
    expect(result?.agentSessionId).toBe("s-123");
    expect(result?.cost?.inputTokens).toBe(115);
    expect(result?.cost?.outputTokens).toBe(43);
    expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.06);
  });

  it("returns undefined cost when message data has no usage/cost", async () => {
    mockExistsSync.mockImplementation(
      (path: string) => path === "/mock/home/.opencode/opencode.db",
    );
    mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      const sql = args[2] ?? "";
      if (sql.includes("FROM session")) {
        return Promise.resolve({
          stdout: JSON.stringify([{ id: "s-1", title: "Title" }]),
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: JSON.stringify([{ data: "{}" }]), stderr: "" });
    });

    const result = await agent.getSessionInfo(makeSession());
    expect(result?.cost).toBeUndefined();
  });

  it("returns null gracefully on sqlite errors", async () => {
    mockExistsSync.mockImplementation(
      (path: string) => path === "/mock/home/.opencode/opencode.db",
    );
    mockExecFileAsync.mockRejectedValue(new Error("sqlite3 unavailable"));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("returns null when workspacePath is missing", async () => {
    const result = await agent.getRestoreCommand?.(
      makeSession({ workspacePath: null }),
      makeLaunchConfig().projectConfig,
    );
    expect(result).toBeNull();
  });

  it("returns restore command with session id and model", async () => {
    mockExistsSync.mockImplementation(
      (path: string) => path === "/mock/home/.opencode/opencode.db",
    );
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ id: "session-xyz" }]),
      stderr: "",
    });

    const result = await agent.getRestoreCommand?.(makeSession(), {
      ...makeLaunchConfig().projectConfig,
      agentConfig: { model: "provider/sonnet" },
    });

    expect(result).toBe(
      "opencode run --session 'session-xyz' --continue --format json --model 'provider/sonnet'",
    );
  });

  it("returns null when no prior session is found", async () => {
    mockExistsSync.mockImplementation(
      (path: string) => path === "/mock/home/.opencode/opencode.db",
    );
    mockExecFileAsync.mockResolvedValue({ stdout: "[]", stderr: "" });
    const result = await agent.getRestoreCommand?.(makeSession(), makeLaunchConfig().projectConfig);
    expect(result).toBeNull();
  });
});

describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("writes plugin file and creates opencode.jsonc when missing", async () => {
    mockExistsSync.mockImplementation((path: string) => {
      if (path === "/workspace/test/opencode.jsonc") return false;
      return path === "/mock/home/.opencode/opencode.db";
    });

    await agent.setupWorkspaceHooks?.("/workspace/test", makeHooksConfig());

    expect(mockMkdir).toHaveBeenCalledWith("/workspace/test/.opencode/plugins", {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/workspace/test/.opencode/plugins/ao-metadata-updater.mjs",
      expect.stringContaining('"tool.execute.after"'),
      "utf-8",
    );
    const configWrite = mockWriteFile.mock.calls.find(
      (call) => call[0] === "/workspace/test/opencode.jsonc",
    );
    expect(configWrite).toBeTruthy();
    const config = JSON.parse(String(configWrite?.[1]));
    expect(config.plugin).toContain("file://.opencode/plugins/ao-metadata-updater.mjs");
  });

  it("merges plugin entry into existing config without clobbering fields", async () => {
    mockExistsSync.mockImplementation((path: string) => path === "/workspace/test/opencode.jsonc");
    mockReadFile.mockResolvedValue(`{
      // keep this field
      "theme": "nord",
      "plugin": ["file://existing-plugin.mjs"],
    }`);

    await agent.setupWorkspaceHooks?.("/workspace/test", makeHooksConfig());

    const configWrite = mockWriteFile.mock.calls.find(
      (call) => call[0] === "/workspace/test/opencode.jsonc",
    );
    const config = JSON.parse(String(configWrite?.[1]));
    expect(config.theme).toBe("nord");
    expect(config.plugin).toContain("file://existing-plugin.mjs");
    expect(config.plugin).toContain("file://.opencode/plugins/ao-metadata-updater.mjs");
  });
});

describe("postLaunchSetup", () => {
  const agent = create();

  it("applies same workspace hook setup after launch", async () => {
    mockExistsSync.mockImplementation((path: string) => path === "/workspace/test/opencode.jsonc");
    mockReadFile.mockResolvedValue('{"plugin":[]}');

    await agent.postLaunchSetup?.(
      makeSession({ workspacePath: "/workspace/test", runtimeHandle: makeProcessHandle(1) }),
    );

    expect(mockWriteFile).toHaveBeenCalledWith(
      "/workspace/test/.opencode/plugins/ao-metadata-updater.mjs",
      expect.any(String),
      "utf-8",
    );
    const configWrite = mockWriteFile.mock.calls.find(
      (call) => call[0] === "/workspace/test/opencode.jsonc",
    );
    const config = JSON.parse(String(configWrite?.[1]));
    expect(config.plugin).toContain("file://.opencode/plugins/ao-metadata-updater.mjs");
  });

  it("no-ops when workspacePath is null", async () => {
    await agent.postLaunchSetup?.(makeSession({ workspacePath: null }));
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
