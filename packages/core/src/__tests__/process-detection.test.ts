import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RuntimeHandle } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures the mock fn exists before vi.mock runs
// ---------------------------------------------------------------------------

const mockExecFileAsync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: () => mockExecFileAsync,
}));

// Import AFTER mocks are declared
const { isAgentProcessRunning, findAgentProcess, resetPsCache, setPsCacheTtlMs } = await import(
  "../process-detection.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmuxHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function processHandle(pid: number): RuntimeHandle {
  return { id: "", runtimeName: "process", data: { pid } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resetPsCache();
  setPsCacheTtlMs(undefined); // restore default
});

describe("isAgentProcessRunning", () => {
  describe("tmux runtime", () => {
    it("returns true when process is found on pane TTY", async () => {
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: "/dev/pts/5\n",
      });
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: [
          "  PID TTY          ARGS",
          " 1234 pts/5        /usr/bin/claude --prompt hello",
          " 5678 pts/6        /usr/bin/bash",
        ].join("\n"),
      });

      expect(await isAgentProcessRunning(tmuxHandle("my-session"), "claude")).toBe(true);
    });

    it("returns false when process is NOT on pane TTY", async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "/dev/pts/5\n" });
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: [
          "  PID TTY          ARGS",
          " 1234 pts/6        /usr/bin/claude --prompt hello",
        ].join("\n"),
      });

      expect(await isAgentProcessRunning(tmuxHandle("my-session"), "claude")).toBe(false);
    });

    it("returns false when no TTYs are found", async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "\n" });

      expect(await isAgentProcessRunning(tmuxHandle("my-session"), "claude")).toBe(false);
    });

    it("matches process name at path boundary", async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "/dev/pts/1\n" });
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: " 42 pts/1 /home/user/.local/bin/aider --yes\n",
      });

      expect(await isAgentProcessRunning(tmuxHandle("s"), "aider")).toBe(true);
    });

    it("does not false-positive on substring matches", async () => {
      mockExecFileAsync.mockResolvedValueOnce({ stdout: "/dev/pts/1\n" });
      mockExecFileAsync.mockResolvedValueOnce({
        stdout: " 42 pts/1 /home/user/.local/bin/not-claude-helper\n",
      });

      expect(await isAgentProcessRunning(tmuxHandle("s"), "claude")).toBe(false);
    });

    it("returns false when tmux command fails", async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error("tmux not running"));

      expect(await isAgentProcessRunning(tmuxHandle("dead"), "claude")).toBe(false);
    });
  });

  describe("process runtime (PID check)", () => {
    it("returns true when PID is alive", async () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      expect(await isAgentProcessRunning(processHandle(12345), "claude")).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(12345, 0);
      killSpy.mockRestore();
    });

    it("returns true when PID exists but EPERM", async () => {
      const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw err;
      });
      expect(await isAgentProcessRunning(processHandle(12345), "claude")).toBe(true);
      killSpy.mockRestore();
    });

    it("returns false when PID does not exist (ESRCH)", async () => {
      const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw err;
      });
      expect(await isAgentProcessRunning(processHandle(12345), "claude")).toBe(false);
      killSpy.mockRestore();
    });

    it("returns false when PID is not valid", async () => {
      const handle: RuntimeHandle = { id: "", runtimeName: "process", data: { pid: "notanumber" } };
      expect(await isAgentProcessRunning(handle, "claude")).toBe(false);
    });

    it("accepts string PID in handle data", async () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const handle: RuntimeHandle = { id: "", runtimeName: "process", data: { pid: "999" } };
      expect(await isAgentProcessRunning(handle, "claude")).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(999, 0);
      killSpy.mockRestore();
    });
  });
});

describe("findAgentProcess", () => {
  it("returns PID for tmux match", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "/dev/pts/5\n" });
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: " 9876 pts/5 /usr/bin/codex --model gpt-4\n",
    });

    expect(await findAgentProcess(tmuxHandle("s"), "codex")).toBe(9876);
  });

  it("returns null when no tmux match", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "/dev/pts/5\n" });
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: " 9876 pts/6 /usr/bin/codex\n",
    });

    expect(await findAgentProcess(tmuxHandle("s"), "codex")).toBeNull();
  });

  it("returns stored PID for process runtime", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await findAgentProcess(processHandle(555), "anything")).toBe(555);
    killSpy.mockRestore();
  });
});

describe("ps cache", () => {
  it("reuses cached ps output within TTL", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "/dev/pts/1\n" }); // tmux
    mockExecFileAsync.mockResolvedValueOnce({ stdout: " 1 pts/1 claude\n" }); // ps

    expect(await isAgentProcessRunning(tmuxHandle("a"), "claude")).toBe(true);

    // Second call — ps should be cached, only tmux call needed
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "/dev/pts/2\n" }); // tmux

    expect(await isAgentProcessRunning(tmuxHandle("b"), "claude")).toBe(false);

    // tmux called twice, ps only once
    expect(mockExecFileAsync).toHaveBeenCalledTimes(3);
  });

  it("refreshes after cache reset", async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "/dev/pts/1\n" });
    mockExecFileAsync.mockResolvedValueOnce({ stdout: " 1 pts/1 claude\n" });
    await isAgentProcessRunning(tmuxHandle("a"), "claude");

    resetPsCache();

    mockExecFileAsync.mockResolvedValueOnce({ stdout: "/dev/pts/1\n" });
    mockExecFileAsync.mockResolvedValueOnce({ stdout: " 1 pts/1 claude\n" });
    await isAgentProcessRunning(tmuxHandle("a"), "claude");

    // 4 total: 2 tmux + 2 ps (cache was reset between calls)
    expect(mockExecFileAsync).toHaveBeenCalledTimes(4);
  });
});
