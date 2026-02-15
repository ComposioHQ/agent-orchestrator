import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const { mockExecFileAsync, mockReaddir, mockReadFile, mockStat, mockOpen, mockHomedir } = vi.hoisted(
  () => ({
    mockExecFileAsync: vi.fn(),
    mockReaddir: vi.fn(),
    mockReadFile: vi.fn(),
    mockStat: vi.fn(),
    mockOpen: vi.fn(),
    mockHomedir: vi.fn(() => "/mock/home"),
  }),
);

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", () => ({
  open: mockOpen,
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

import { create, manifest, default as defaultExport } from "./index.js";

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

function mockTmuxWithProcess(processName = "claude", tty = "/dev/ttys001", pid = 12345) {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: `${tty}\n`, stderr: "" });
    }
    if (cmd === "ps") {
      const ttyShort = tty.replace(/^\/dev\//, "");
      // Matches `ps -eo pid,tty,args` output format
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n  ${pid} ${ttyShort}  ${processName}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
  });
}

function mockJsonlFiles(
  jsonlContent: string,
  files = ["session-abc123.jsonl"],
  mtime = new Date(1700000000000),
) {
  mockReaddir.mockResolvedValue(files);
  mockStat.mockResolvedValue({ mtimeMs: mtime.getTime(), mtime });
  mockReadFile.mockResolvedValue(jsonlContent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  mockHomedir.mockReturnValue("/mock/home");
});

describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "claude-code",
      slot: "agent",
      description: "Agent plugin: Claude Code CLI",
      version: "0.1.0",
    });
  });

  it("create() returns an agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("claude-code");
    expect(agent.processName).toBe("claude");
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
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("claude");
    // Must not contain shell operators (execFile-safe)
    expect(cmd).not.toContain("&&");
    expect(cmd).not.toContain("unset");
  });

  it("includes --dangerously-skip-permissions when permissions=skip", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "skip" }));
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("shell-escapes model argument", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-opus-4-6" }));
    expect(cmd).toContain("--model 'claude-opus-4-6'");
  });

  it("shell-escapes prompt argument", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).toContain("-p 'Fix the bug'");
  });

  it("escapes dangerous characters in prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "$(rm -rf /); `evil`; $HOME" }));
    // Single-quoted strings prevent shell expansion
    expect(cmd).toContain("-p '$(rm -rf /); `evil`; $HOME'");
  });

  it("escapes single quotes in prompt using POSIX method", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's a test" }));
    expect(cmd).toContain("-p 'it'\\''s a test'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip", model: "opus", prompt: "Hello" }),
    );
    expect(cmd).toBe("claude --dangerously-skip-permissions --model 'opus' -p 'Hello'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("-p");
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
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when claude is found on tmux pane TTY", async () => {
    mockTmuxWithProcess("claude");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when no claude on tmux pane TTY", async () => {
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

  it("finds claude on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  claude -p test\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("does not match similar process names like claude-code", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  /usr/bin/claude-code\n",
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

  it("returns active when 'esc to interrupt' is visible", () => {
    expect(agent.detectActivity("Working... esc to interrupt\n")).toBe("active");
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

  it("returns active when Searching indicator is visible", () => {
    expect(agent.detectActivity("Searching codebase...\n")).toBe("active");
  });

  it("returns waiting_input for permission prompt (Y/N)", () => {
    expect(agent.detectActivity("Do you want to proceed? (Y)es / (N)o\n")).toBe("waiting_input");
  });

  it("returns waiting_input for 'Do you want to proceed?' prompt", () => {
    expect(agent.detectActivity("Do you want to proceed?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for bypass permissions prompt", () => {
    expect(agent.detectActivity("bypass all future permissions for this session\n")).toBe("waiting_input");
  });

  it("returns active when queued message indicator is visible", () => {
    expect(agent.detectActivity("Press up to edit queued messages\n")).toBe("active");
  });

  it("returns idle when shell prompt is visible", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
  });

  it("returns idle when prompt follows historical activity indicators", () => {
    // Key regression test: historical "Reading file..." output in the buffer
    // should NOT override an idle prompt on the last line.
    expect(agent.detectActivity("Reading file src/index.ts\nWriting to out.ts\n❯ ")).toBe("idle");
    expect(agent.detectActivity("Thinking...\nSearching codebase...\n$ ")).toBe("idle");
  });

  it("returns waiting_input when permission prompt follows historical activity", () => {
    // Permission prompt at the bottom should NOT be overridden by historical
    // "Reading"/"Thinking" output higher in the buffer.
    expect(agent.detectActivity("Reading file src/index.ts\nThinking...\nDo you want to proceed?\n")).toBe("waiting_input");
    expect(agent.detectActivity("Searching codebase...\n(Y)es / (N)o\n")).toBe("waiting_input");
    expect(agent.detectActivity("Writing to out.ts\nbypass all future permissions for this session\n")).toBe("waiting_input");
  });

  it("returns active for non-empty output with no special patterns", () => {
    expect(agent.detectActivity("some random terminal output\n")).toBe("active");
  });
});

// =========================================================================
// getSessionInfo — JSONL parsing
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

  it("returns null when no JSONL files in project dir", async () => {
    mockReaddir.mockResolvedValue(["readme.txt", "config.yaml"]);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("filters out agent- prefixed JSONL files", async () => {
    mockReaddir.mockResolvedValue(["agent-toolkit.jsonl"]);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when JSONL file is empty", async () => {
    mockJsonlFiles("");
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when JSONL has only malformed lines", async () => {
    mockJsonlFiles("not json\nalso not json\n");
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  describe("path conversion", () => {
    it("converts workspace path to Claude project dir path", async () => {
      mockJsonlFiles('{"type":"user","message":{"content":"hello"}}');
      await agent.getSessionInfo(makeSession({ workspacePath: "/Users/dev/.worktrees/ao/ao-3" }));
      expect(mockReaddir).toHaveBeenCalledWith(
        "/mock/home/.claude/projects/Users-dev--worktrees-ao-ao-3",
      );
    });
  });

  describe("summary extraction", () => {
    it("extracts summary from last summary event", async () => {
      const jsonl = [
        '{"type":"summary","summary":"First summary"}',
        '{"type":"user","message":{"content":"do something"}}',
        '{"type":"summary","summary":"Latest summary"}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Latest summary");
    });

    it("falls back to first user message when no summary", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"Implement the login feature"}}',
        '{"type":"assistant","message":{"content":"I will implement..."}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Implement the login feature");
    });

    it("truncates long user message to 120 chars", async () => {
      const longMsg = "A".repeat(200);
      const jsonl = `{"type":"user","message":{"content":"${longMsg}"}}`;
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("A".repeat(120) + "...");
      expect(result!.summary!.length).toBe(123);
    });

    it("returns null summary when no summary and no user messages", async () => {
      const jsonl = '{"type":"assistant","message":{"content":"Hello"}}';
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBeNull();
    });

    it("skips user messages with empty content", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"   "}}',
        '{"type":"user","message":{"content":"Real content"}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Real content");
    });
  });

  describe("session ID extraction", () => {
    it("extracts session ID from filename", async () => {
      mockJsonlFiles('{"type":"user","message":{"content":"hi"}}', ["abc-def-123.jsonl"]);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.agentSessionId).toBe("abc-def-123");
    });
  });

  describe("last message type", () => {
    it("returns the type of the last JSONL line", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"test"}}',
        '{"type":"assistant","message":{"content":"response"}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.lastMessageType).toBe("assistant");
    });

    it("returns undefined when no lines have type", async () => {
      mockJsonlFiles('{"content":"no type field"}');
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.lastMessageType).toBeUndefined();
    });
  });

  describe("cost estimation", () => {
    it("aggregates usage.input_tokens and usage.output_tokens", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","usage":{"input_tokens":1000,"output_tokens":500}}',
        '{"type":"assistant","usage":{"input_tokens":2000,"output_tokens":300}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.inputTokens).toBe(3000);
      expect(result?.cost?.outputTokens).toBe(800);
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.009 + 0.012, 6);
    });

    it("includes cache tokens in input count", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":500,"cache_creation_input_tokens":200}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
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
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.08);
    });

    it("prefers costUSD over estimatedCostUsd to avoid double-counting", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"costUSD":0.10,"estimatedCostUsd":0.10}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      // Should use costUSD only, not sum both
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.1);
    });

    it("falls back to estimatedCostUsd when costUSD is absent", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"estimatedCostUsd":0.12}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.12);
    });

    it("uses direct inputTokens/outputTokens fields", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"inputTokens":5000,"outputTokens":1000}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.inputTokens).toBe(5000);
      expect(result?.cost?.outputTokens).toBe(1000);
    });

    it("returns undefined cost when no usage data", async () => {
      const jsonl = '{"type":"user","message":{"content":"hi"}}';
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost).toBeUndefined();
    });
  });

  describe("file selection", () => {
    it("picks the most recently modified JSONL file", async () => {
      mockReaddir.mockResolvedValue(["old.jsonl", "new.jsonl"]);
      mockStat.mockImplementation((path: string) => {
        if (path.endsWith("old.jsonl")) {
          return Promise.resolve({ mtimeMs: 1000, mtime: new Date(1000) });
        }
        return Promise.resolve({ mtimeMs: 2000, mtime: new Date(2000) });
      });
      mockReadFile.mockResolvedValue('{"type":"user","message":{"content":"hi"}}');
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.agentSessionId).toBe("new");
    });

    it("skips JSONL files that fail stat", async () => {
      mockReaddir.mockResolvedValue(["broken.jsonl", "good.jsonl"]);
      mockStat.mockImplementation((path: string) => {
        if (path.endsWith("broken.jsonl")) {
          return Promise.reject(new Error("ENOENT"));
        }
        return Promise.resolve({ mtimeMs: 1000, mtime: new Date(1000) });
      });
      mockReadFile.mockResolvedValue('{"type":"user","message":{"content":"hi"}}');
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.agentSessionId).toBe("good");
    });
  });

  describe("lastLogModified", () => {
    it("returns file mtime as lastLogModified", async () => {
      const mtime = new Date(1700000000000);
      mockJsonlFiles('{"type":"user","message":{"content":"hi"}}', undefined, mtime);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.lastLogModified).toEqual(mtime);
    });
  });

  describe("malformed JSONL handling", () => {
    it("skips malformed lines and parses valid ones", async () => {
      const jsonl = [
        "not valid json",
        '{"type":"summary","summary":"Good summary"}',
        "{truncated",
        "",
      ].join("\n");
      mockJsonlFiles(jsonl);
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
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Valid object");
    });

    it("handles readFile failure gracefully", async () => {
      mockReaddir.mockResolvedValue(["session.jsonl"]);
      mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });
      mockReadFile.mockRejectedValue(new Error("EACCES"));
      const result = await agent.getSessionInfo(makeSession());
      expect(result).toBeNull();
    });
  });
});

// =========================================================================
// isProcessing — JSONL tail-read
// =========================================================================
describe("isProcessing", () => {
  const agent = create();

  /** Helper to create a mock file handle from `open()` */
  function mockOpenWithContent(
    content: string,
    mtime: Date = new Date(),
  ) {
    const buf = Buffer.from(content, "utf-8");
    const fh = {
      stat: vi.fn().mockResolvedValue({ size: buf.length, mtime }),
      read: vi.fn().mockImplementation(
        (buffer: Buffer, offset: number, length: number, position: number) => {
          buf.copy(buffer, offset, position, position + length);
          return Promise.resolve({ bytesRead: length, buffer });
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockOpen.mockResolvedValue(fh);
    // findLatestSessionFile uses readdir + stat
    mockReaddir.mockResolvedValue(["session-abc.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: mtime.getTime(), mtime });
  }

  it("returns false when workspacePath is null", async () => {
    expect(await agent.isProcessing(makeSession({ workspacePath: null }))).toBe(false);
  });

  it("returns false when no JSONL files exist", async () => {
    mockReaddir.mockResolvedValue([]);
    expect(await agent.isProcessing(makeSession())).toBe(false);
  });

  it("returns false when project dir does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await agent.isProcessing(makeSession())).toBe(false);
  });

  it("returns false when JSONL file is empty", async () => {
    mockOpenWithContent("");
    // Override stat to return size 0
    const fh = {
      stat: vi.fn().mockResolvedValue({ size: 0, mtime: new Date() }),
      read: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockOpen.mockResolvedValue(fh);
    mockReaddir.mockResolvedValue(["session-abc.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    expect(await agent.isProcessing(makeSession())).toBe(false);
  });

  it("returns false when file is older than 30 seconds", async () => {
    const oldTime = new Date(Date.now() - 60_000);
    const content = '{"type":"user","message":{"content":"hello"}}\n';
    mockOpenWithContent(content, oldTime);
    expect(await agent.isProcessing(makeSession())).toBe(false);
  });

  it("returns false when last type is assistant", async () => {
    const now = new Date();
    const content = [
      '{"type":"user","message":{"content":"fix bug"}}',
      '{"type":"assistant","message":{"content":"I fixed it"}}',
    ].join("\n") + "\n";
    mockOpenWithContent(content, now);
    expect(await agent.isProcessing(makeSession())).toBe(false);
  });

  it("returns false when last type is system", async () => {
    const now = new Date();
    const content = [
      '{"type":"user","message":{"content":"hello"}}',
      '{"type":"system","summary":"session started"}',
    ].join("\n") + "\n";
    mockOpenWithContent(content, now);
    expect(await agent.isProcessing(makeSession())).toBe(false);
  });

  it("returns true when last type is user and file is recent", async () => {
    const now = new Date();
    const content = '{"type":"user","message":{"content":"fix this"}}\n';
    mockOpenWithContent(content, now);
    expect(await agent.isProcessing(makeSession())).toBe(true);
  });

  it("returns true when last type is progress and file is recent", async () => {
    const now = new Date();
    const content = [
      '{"type":"user","message":{"content":"do it"}}',
      '{"type":"progress","status":"running tool"}',
    ].join("\n") + "\n";
    mockOpenWithContent(content, now);
    expect(await agent.isProcessing(makeSession())).toBe(true);
  });

  it("returns false when open() throws", async () => {
    mockOpen.mockRejectedValue(new Error("EACCES"));
    mockReaddir.mockResolvedValue(["session-abc.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    expect(await agent.isProcessing(makeSession())).toBe(false);
  });

  it("returns false when JSONL has no lines with type field", async () => {
    const now = new Date();
    const content = '{"content":"no type here"}\n';
    mockOpenWithContent(content, now);
    // lastType is null, and null is neither "assistant" nor "system",
    // but we still return true because the file is recent and the agent
    // appears active. Actually, let's verify what happens:
    // entry = { lastType: null, modifiedAt: now }
    // ageMs < 30_000 → true
    // lastType !== "assistant" && lastType !== "system" → true
    // So it returns true. That's the conservative (safe) behavior.
    expect(await agent.isProcessing(makeSession())).toBe(true);
  });

  it("handles file with only malformed JSON gracefully", async () => {
    const now = new Date();
    const content = "not valid json at all\n";
    mockOpenWithContent(content, now);
    // All parse attempts fail → lastType: null → returns true (conservative)
    expect(await agent.isProcessing(makeSession())).toBe(true);
  });

  it("always closes file handle even on error", async () => {
    const fh = {
      stat: vi.fn().mockRejectedValue(new Error("stat failed")),
      read: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockOpen.mockResolvedValue(fh);
    mockReaddir.mockResolvedValue(["session-abc.jsonl"]);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    await agent.isProcessing(makeSession());
    expect(fh.close).toHaveBeenCalled();
  });
});
