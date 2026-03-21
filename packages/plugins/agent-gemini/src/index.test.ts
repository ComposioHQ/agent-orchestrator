import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockWriteFile,
  mockMkdir,
  mockReadFile,
  mockReaddir,
  mockStat,
  mockChmod,
  mockExistsSync,
  mockHomedir,
} =
  vi.hoisted(() => ({
    mockExecFileAsync: vi.fn(),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockReadFile: vi.fn(),
    mockReaddir: vi.fn(),
    mockStat: vi.fn(),
    mockChmod: vi.fn().mockResolvedValue(undefined),
    mockExistsSync: vi.fn(() => false),
    mockHomedir: vi.fn(() => "/mock/home"),
  }));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});


vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
  chmod: mockChmod,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

import { create, manifest, toGeminiProjectPath, default as defaultExport, resetPsCache } from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test-project",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
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

function mockTmuxWithProcess(processName = "gemini", tty = "/dev/ttys001", pid = 12345) {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: `${tty}\n`, stderr: "" });
    }
    if (cmd === "ps") {
      const ttyShort = tty.replace(/^\/dev\//, "");
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n  ${pid} ${ttyShort}  ${processName}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
  });
}

function mockJsonFiles(
  jsonContent: string,
  files = ["session-abc123.json"],
  mtime = new Date(1700000000000),
) {
  mockReaddir.mockResolvedValue(files);
  mockStat.mockResolvedValue({ mtimeMs: mtime.getTime(), mtime });
  mockReadFile.mockResolvedValue(jsonContent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  resetPsCache();
  mockHomedir.mockReturnValue("/mock/home");
  mockExistsSync.mockReturnValue(false);
});

describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "gemini",
      slot: "agent",
      description: "Agent plugin: Gemini CLI",
      version: "0.1.0",
    });
  });

  it("create() returns an agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("gemini");
    expect(agent.processName).toBe("gemini");
    expect(agent.promptDelivery).toBe("post-launch");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

// =========================================================================
// getLaunchCommand
// =========================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command without shell syntax", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "default" }));
    expect(cmd).toBe("gemini");
    // Must not contain shell operators (execFile-safe)
    expect(cmd).not.toContain("&&");
    expect(cmd).not.toContain("unset");
  });

  it("includes --yolo when permissions=permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--yolo");
  });

  it("treats legacy permissions=skip as permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip" as unknown as AgentLaunchConfig["permissions"] }),
    );
    expect(cmd).toContain("--yolo");
  });

  it("maps permissions=auto-edit to --yolo", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--yolo");
  });

  it("shell-escapes model argument", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gemini-2.0-flash" }));
    expect(cmd).toContain("--model 'gemini-2.0-flash'");
  });

  it("does not include -p flag (prompt delivered post-launch)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).not.toContain("-p");
    expect(cmd).not.toContain("Fix the bug");
  });

  it("combines all options without prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless", model: "flash", prompt: "Hello" }),
    );
    expect(cmd).toBe("gemini --yolo --model 'flash'");
  });

  it("omits --yolo when permissions=default", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "default" }));
    expect(cmd).not.toContain("--yolo");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("-p");
  });

  it("does not include system prompt in launch command (delivered via env var)", () => {
    // Gemini uses GEMINI_SYSTEM_MD env var, not a CLI flag
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPrompt: "You are a helper", prompt: "Do the task" }),
    );
    expect(cmd).not.toContain("system");
    expect(cmd).not.toContain("You are a helper");
    expect(cmd).not.toContain("Do the task");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets CLAUDECODE to empty string (replaces unset in command)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["CLAUDECODE"]).toBe("");
  });

  it("sets AO_SESSION_ID but not AO_PROJECT_ID (caller's responsibility)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_PROJECT_ID"]).toBeUndefined();
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-100" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-100");
  });

  it("does not set AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });

  it("does not set GEMINI_SYSTEM_MD when no system prompt provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["GEMINI_SYSTEM_MD"]).toBeUndefined();
  });

  it("sets GEMINI_SYSTEM_MD to file path when systemPromptFile provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md" }));
    expect(env["GEMINI_SYSTEM_MD"]).toBe("/tmp/prompt.md");
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when gemini is found on tmux pane TTY", async () => {
    mockTmuxWithProcess("gemini");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when no gemini on tmux pane TTY", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys002\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  999 ttys002  bash\n",
          stderr: "",
        });
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when tmux list-panes returns empty", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process runtime with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(999))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(999, 0);
    killSpy.mockRestore();
  });

  it("returns false for process runtime with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(999))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false for unknown runtime without PID (no pgrep fallback)", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
    // Must NOT call pgrep — could match wrong session
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns false when tmux command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("fail"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("finds gemini on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  gemini --yolo\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("does not match similar process names like gemini-cli-helper", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  /usr/bin/gemini-cli-helper\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });
});

// =========================================================================
// detectActivity — terminal output classification
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  \n  ")).toBe("idle");
  });

  it("returns active when processing indicator is visible", () => {
    expect(agent.detectActivity("Working...\n")).toBe("active");
  });

  it("returns active when Thinking indicator is visible", () => {
    expect(agent.detectActivity("Thinking...\n")).toBe("active");
  });

  it("returns active when Reading indicator is visible", () => {
    expect(agent.detectActivity("Reading file src/index.ts\n")).toBe("active");
  });

  it("returns active when Writing indicator is visible", () => {
    expect(agent.detectActivity("Writing to src/main.ts\n")).toBe("active");
  });

  it("returns waiting_input for permission prompt (Y/N)", () => {
    expect(agent.detectActivity("Do you want to proceed? (Y)es / (N)o\n")).toBe("waiting_input");
  });

  it("returns waiting_input for 'Do you want to proceed?' prompt", () => {
    expect(agent.detectActivity("Do you want to proceed?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for bypass permissions prompt", () => {
    expect(agent.detectActivity("bypass all future permissions for this session\n")).toBe(
      "waiting_input",
    );
  });

  it("returns idle when shell prompt (❯) is visible", () => {
    expect(agent.detectActivity("some output\n❯ ")).toBe("idle");
  });

  it("returns idle when shell prompt (>) is visible", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
  });

  it("returns idle when prompt follows historical activity indicators", () => {
    expect(agent.detectActivity("Reading file src/index.ts\nWriting to out.ts\n❯ ")).toBe("idle");
    expect(agent.detectActivity("Thinking...\n$ ")).toBe("idle");
  });

  it("returns waiting_input when permission prompt follows historical activity", () => {
    expect(
      agent.detectActivity("Reading file src/index.ts\nThinking...\nDo you want to proceed?\n"),
    ).toBe("waiting_input");
    expect(agent.detectActivity("Searching codebase...\n(Y)es / (N)o\n")).toBe("waiting_input");
  });

  it("returns active for non-empty output with no special patterns", () => {
    expect(agent.detectActivity("some random terminal output\n")).toBe("active");
  });
});

// =========================================================================
// getSessionInfo — JSON parsing
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("returns null when workspacePath is null", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when project directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when no JSON files in project dir", async () => {
    mockReaddir.mockResolvedValue(["readme.txt", "config.yaml"]);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("filters out agent- prefixed JSON files", async () => {
    mockReaddir.mockResolvedValue(["agent-toolkit.json"]);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when JSON file is empty", async () => {
    mockJsonFiles("");
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when JSON has only malformed lines", async () => {
    mockJsonFiles("not json\nalso not json\n");
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  describe("path conversion", () => {
    it("converts workspace path to Gemini SHA-256 project dir path", async () => {
      mockJsonFiles('{"type":"user","message":{"content":"hello"}}');
      const workspacePath = "/Users/dev/.worktrees/ao/ao-3";
      await agent.getSessionInfo(makeSession({ workspacePath }));
      const expectedHash = toGeminiProjectPath(workspacePath);
      expect(mockReaddir).toHaveBeenCalledWith(
        `/mock/home/.gemini/tmp/${expectedHash}/chats`,
      );
    });
  });

  describe("summary extraction", () => {
    it("extracts summary from last summary event and marks as not fallback", async () => {
      const jsonl = [
        '{"type":"summary","summary":"First summary"}',
        '{"type":"user","message":{"content":"do something"}}',
        '{"type":"summary","summary":"Latest summary"}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Latest summary");
      expect(result?.summaryIsFallback).toBe(false);
    });

    it("falls back to first user message and marks as fallback", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"Implement the login feature"}}',
        '{"type":"assistant","message":{"content":"I will implement..."}}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Implement the login feature");
      expect(result?.summaryIsFallback).toBe(true);
    });

    it("truncates long user message to 120 chars", async () => {
      const longMsg = "A".repeat(200);
      const jsonl = `{"type":"user","message":{"content":"${longMsg}"}}`;
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("A".repeat(120) + "...");
      expect(result!.summary!.length).toBe(123);
      expect(result?.summaryIsFallback).toBe(true);
    });

    it("returns null summary when no summary and no user messages", async () => {
      const jsonl = '{"type":"assistant","message":{"content":"Hello"}}';
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBeNull();
      expect(result?.summaryIsFallback).toBeUndefined();
    });

    it("skips user messages with empty content", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"   "}}',
        '{"type":"user","message":{"content":"Real content"}}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Real content");
      expect(result?.summaryIsFallback).toBe(true);
    });
  });

  describe("session ID extraction", () => {
    it("extracts session ID from filename (strips .json extension)", async () => {
      mockJsonFiles('{"type":"user","message":{"content":"hi"}}', ["abc-def-123.json"]);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.agentSessionId).toBe("abc-def-123");
    });
  });

  describe("cost estimation", () => {
    it("aggregates usage.input_tokens and usage.output_tokens with Gemini pricing", async () => {
      // Gemini CLI does not expose cost data — no defaultCostRate configured
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","usage":{"input_tokens":1000,"output_tokens":500}}',
        '{"type":"assistant","usage":{"input_tokens":2000,"output_tokens":300}}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.inputTokens).toBe(3000);
      expect(result?.cost?.outputTokens).toBe(800);
      // Without defaultCostRate, estimatedCostUsd is 0
      expect(result?.cost?.estimatedCostUsd).toBe(0);
    });

    it("includes cache tokens in input count", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":500,"cache_creation_input_tokens":200}}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.inputTokens).toBe(800);
      expect(result?.cost?.outputTokens).toBe(50);
    });

    it("uses costUSD field when present", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"costUSD":0.05}',
        '{"costUSD":0.03}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.08);
    });

    it("prefers costUSD over estimatedCostUsd to avoid double-counting", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"costUSD":0.10,"estimatedCostUsd":0.10}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.1);
    });

    it("falls back to estimatedCostUsd when costUSD is absent", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"estimatedCostUsd":0.12}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.12);
    });

    it("uses direct inputTokens/outputTokens fields", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"inputTokens":5000,"outputTokens":1000}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.inputTokens).toBe(5000);
      expect(result?.cost?.outputTokens).toBe(1000);
    });

    it("returns undefined cost when no usage data", async () => {
      const jsonl = '{"type":"user","message":{"content":"hi"}}';
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost).toBeUndefined();
    });
  });

  describe("file selection", () => {
    it("picks the most recently modified JSON file", async () => {
      mockReaddir.mockResolvedValue(["old.json", "new.json"]);
      mockStat.mockImplementation((path: string) => {
        if (path.endsWith("old.json")) {
          return Promise.resolve({ mtimeMs: 1000, mtime: new Date(1000) });
        }
        return Promise.resolve({ mtimeMs: 2000, mtime: new Date(2000) });
      });
      mockReadFile.mockResolvedValue('{"type":"user","message":{"content":"hi"}}');
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.agentSessionId).toBe("new");
    });

    it("skips JSON files that fail stat", async () => {
      mockReaddir.mockResolvedValue(["broken.json", "good.json"]);
      mockStat.mockImplementation((path: string) => {
        if (path.endsWith("broken.json")) {
          return Promise.reject(new Error("ENOENT"));
        }
        return Promise.resolve({ mtimeMs: 1000, mtime: new Date(1000) });
      });
      mockReadFile.mockResolvedValue('{"type":"user","message":{"content":"hi"}}');
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.agentSessionId).toBe("good");
    });
  });

  describe("malformed JSON handling", () => {
    it("skips malformed lines and parses valid ones", async () => {
      const jsonl = [
        "not valid json",
        '{"type":"summary","summary":"Good summary"}',
        "{truncated",
        "",
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Good summary");
    });

    it("skips JSON null, array, and primitive values", async () => {
      const jsonl = [
        "null",
        "42",
        '"just a string"',
        "[1,2,3]",
        '{"type":"summary","summary":"Valid object"}',
      ].join("\n");
      mockJsonFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Valid object");
    });

    it("handles readFile failure gracefully", async () => {
      mockReaddir.mockResolvedValue(["session.json"]);
      mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });
      mockReadFile.mockRejectedValue(new Error("EACCES"));
      const result = await agent.getSessionInfo(makeSession());
      expect(result).toBeNull();
    });
  });
});

// =========================================================================
// setupWorkspaceHooks
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  function readMetadataUpdaterScript(): string {
    const call = mockWriteFile.mock.calls.find((entry) =>
      String(entry[0]).includes("metadata-updater.sh"),
    );
    expect(call).toBeDefined();
    return call![1] as string;
  }

  it("bootstraps settings.json path when it does not exist", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const metadataScript = readMetadataUpdaterScript();
    expect(metadataScript).not.toContain("__AO_HOOK_TOOL_MATCHER__");
    expect(metadataScript).toContain('if [[ "$tool_name" != "run_shell_command" ]]; then');

    const settingsWriteCall = mockWriteFile.mock.calls.at(-1);
    expect(settingsWriteCall).toBeDefined();
    const writtenContent = settingsWriteCall![1] as string;
    const updated = JSON.parse(writtenContent) as {
      hooks?: { AfterTool?: Array<{ matcher: string; hooks: Array<{ command: string }> }>; };
    };
    expect(updated.hooks?.AfterTool?.[0]?.matcher).toBe("run_shell_command");
    expect(mockExistsSync).toHaveBeenCalled();
  });

  it("migrates existing metadata hook matcher from Bash to run_shell_command", async () => {
    mockExistsSync.mockReturnValue(true);
    const existingSettings = {
      hooks: {
        AfterTool: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "AO_DATA_DIR=/data /workspace/test/.gemini/metadata-updater.sh",
              },
            ],
          },
        ],
      },
    };

    mockReadFile.mockResolvedValue(JSON.stringify(existingSettings));

    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });

    const metadataScript = readMetadataUpdaterScript();
    expect(metadataScript).not.toContain("__AO_HOOK_TOOL_MATCHER__");
    expect(metadataScript).toContain('if [[ "$tool_name" != "run_shell_command" ]]; then');

    const settingsWriteCall = mockWriteFile.mock.calls.at(-1);
    expect(settingsWriteCall).toBeDefined();

    const writtenContent = settingsWriteCall![1] as string;
    const updated = JSON.parse(writtenContent) as {
      hooks?: { AfterTool?: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };

    expect(updated.hooks?.AfterTool?.[0]?.matcher).toBe("run_shell_command");
    expect(updated.hooks?.AfterTool?.[0]?.hooks?.[0]?.command).toContain("metadata-updater.sh");
  });
});
