import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted() runs before vi.mock() factory
// ---------------------------------------------------------------------------

const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

import { readLastJsonlEntry, isAgentProcessRunning } from "../utils.js";
import type { RuntimeHandle } from "../types.js";

// ---------------------------------------------------------------------------
// readLastJsonlEntry
// ---------------------------------------------------------------------------

describe("readLastJsonlEntry", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(content: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-utils-test-"));
    const filePath = join(tmpDir, "test.jsonl");
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  it("returns null for empty file", async () => {
    const path = setup("");
    expect(await readLastJsonlEntry(path)).toBeNull();
  });

  it("returns null for nonexistent file", async () => {
    expect(await readLastJsonlEntry("/tmp/nonexistent-ao-test.jsonl")).toBeNull();
  });

  it("reads last entry type from single-line JSONL", async () => {
    const path = setup('{"type":"assistant","message":"hello"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBe("assistant");
  });

  it("reads last entry from multi-line JSONL", async () => {
    const path = setup(
      '{"type":"human","text":"hi"}\n{"type":"assistant","text":"hello"}\n{"type":"result","text":"done"}\n',
    );
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("result");
  });

  it("handles trailing newlines", async () => {
    const path = setup('{"type":"done"}\n\n\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("done");
  });

  it("returns lastType null for entry without type field", async () => {
    const path = setup('{"message":"no type"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const path = setup("not json at all\n");
    expect(await readLastJsonlEntry(path)).toBeNull();
  });

  it("handles multi-byte UTF-8 characters in JSONL entries", async () => {
    // Create a JSONL entry with multi-byte characters (CJK, emoji)
    const entry = { type: "assistant", text: "日本語テスト 🎉 données résumé" };
    const path = setup(JSON.stringify(entry) + "\n");
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("assistant");
  });

  it("handles multi-byte UTF-8 at chunk boundaries", async () => {
    // Create content larger than the 4096 byte chunk size with multi-byte
    // characters that could straddle a boundary. Each 🎉 is 4 bytes.
    const padding = '{"type":"padding","data":"' + "x".repeat(4080) + '"}\n';
    // The emoji-heavy last line will be at a chunk boundary
    const lastLine = { type: "final", text: "🎉".repeat(100) };
    const path = setup(padding + JSON.stringify(lastLine) + "\n");
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("final");
  });

  it("returns modifiedAt as a Date", async () => {
    const path = setup('{"type":"test"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.modifiedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// isAgentProcessRunning
// ---------------------------------------------------------------------------

describe("isAgentProcessRunning", () => {
  afterEach(() => {
    mockExecFileAsync.mockReset();
  });

  function tmuxHandle(id: string): RuntimeHandle {
    return { id, runtimeName: "tmux", data: {} };
  }

  function pidHandle(pid: number): RuntimeHandle {
    return { id: "", runtimeName: "process", data: { pid } };
  }

  /**
   * Set up sequential responses for execFileAsync calls.
   * First call returns results[0], second returns results[1], etc.
   */
  function setupExecResponses(...results: { stdout: string }[]) {
    let callIndex = 0;
    mockExecFileAsync.mockImplementation(() => {
      const result = results[callIndex++];
      if (!result) return Promise.reject(new Error("unexpected call"));
      return Promise.resolve(result);
    });
  }

  describe("tmux runtime", () => {
    it("returns true when process is found on the tmux pane TTY", async () => {
      setupExecResponses(
        { stdout: "/dev/ttys042\n" },
        {
          stdout: [
            "  PID TTY      ARGS",
            "  123 ttys042  /usr/bin/claude --config foo",
            "  456 ttys099  /usr/bin/node server.js",
          ].join("\n"),
        },
      );

      expect(await isAgentProcessRunning(tmuxHandle("my-session"), "claude")).toBe(true);
    });

    it("returns false when process is NOT on the tmux pane TTY", async () => {
      setupExecResponses(
        { stdout: "/dev/ttys042\n" },
        {
          stdout: [
            "  PID TTY      ARGS",
            "  123 ttys099  /usr/bin/claude --config foo",
          ].join("\n"),
        },
      );

      expect(await isAgentProcessRunning(tmuxHandle("my-session"), "claude")).toBe(false);
    });

    it("returns false when no pane TTY is returned", async () => {
      setupExecResponses({ stdout: "\n" });

      expect(await isAgentProcessRunning(tmuxHandle("my-session"), "claude")).toBe(false);
    });

    it("matches process name at start of args (bare command)", async () => {
      setupExecResponses(
        { stdout: "/dev/ttys001\n" },
        {
          stdout: [
            "  PID TTY      ARGS",
            "  100 ttys001  aider --message hello",
          ].join("\n"),
        },
      );

      expect(await isAgentProcessRunning(tmuxHandle("s"), "aider")).toBe(true);
    });

    it("matches process name after path separator", async () => {
      setupExecResponses(
        { stdout: "/dev/ttys001\n" },
        {
          stdout: [
            "  PID TTY      ARGS",
            "  100 ttys001  /home/user/.local/bin/codex run test",
          ].join("\n"),
        },
      );

      expect(await isAgentProcessRunning(tmuxHandle("s"), "codex")).toBe(true);
    });

    it("does not match process name as substring", async () => {
      setupExecResponses(
        { stdout: "/dev/ttys001\n" },
        {
          stdout: [
            "  PID TTY      ARGS",
            "  100 ttys001  claudesmith --some-flag",
          ].join("\n"),
        },
      );

      expect(await isAgentProcessRunning(tmuxHandle("s"), "claude")).toBe(false);
    });

    it("escapes regex metacharacters in process name", async () => {
      setupExecResponses(
        { stdout: "/dev/ttys001\n" },
        {
          stdout: [
            "  PID TTY      ARGS",
            "  100 ttys001  c++compiler --opt",
          ].join("\n"),
        },
      );

      // "c++" has regex metacharacters — should not throw or match incorrectly
      expect(await isAgentProcessRunning(tmuxHandle("s"), "c++")).toBe(false);
    });

    it("handles multiple pane TTYs", async () => {
      setupExecResponses(
        { stdout: "/dev/ttys001\n/dev/ttys002\n" },
        {
          stdout: [
            "  PID TTY      ARGS",
            "  100 ttys002  claude --prompt test",
          ].join("\n"),
        },
      );

      expect(await isAgentProcessRunning(tmuxHandle("s"), "claude")).toBe(true);
    });

    it("returns false when tmux command fails", async () => {
      mockExecFileAsync.mockRejectedValue(new Error("no server running"));

      expect(await isAgentProcessRunning(tmuxHandle("bad"), "claude")).toBe(false);
    });
  });

  describe("PID-based fallback", () => {
    it("returns true when PID is alive", async () => {
      // Use current process PID which is definitely alive
      const handle = pidHandle(process.pid);
      expect(await isAgentProcessRunning(handle, "anything")).toBe(true);
    });

    it("returns false for non-existent PID", async () => {
      // PID 2147483647 is unlikely to exist
      const handle = pidHandle(2147483647);
      expect(await isAgentProcessRunning(handle, "anything")).toBe(false);
    });

    it("returns false when PID is 0 or negative", async () => {
      expect(await isAgentProcessRunning(pidHandle(0), "x")).toBe(false);
      expect(await isAgentProcessRunning(pidHandle(-1), "x")).toBe(false);
    });

    it("returns false when PID is NaN", async () => {
      const handle: RuntimeHandle = {
        id: "",
        runtimeName: "process",
        data: { pid: "not-a-number" },
      };
      expect(await isAgentProcessRunning(handle, "x")).toBe(false);
    });

    it("handles string PID from handle data", async () => {
      const handle: RuntimeHandle = {
        id: "",
        runtimeName: "process",
        data: { pid: String(process.pid) },
      };
      expect(await isAgentProcessRunning(handle, "anything")).toBe(true);
    });

    it("returns true when process.kill throws EPERM (process exists, no permission)", async () => {
      const epermError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw epermError;
      });
      try {
        // PID 999 won't actually be checked — the mock throws EPERM
        const handle = pidHandle(999);
        expect(await isAgentProcessRunning(handle, "x")).toBe(true);
      } finally {
        killSpy.mockRestore();
      }
    });

    it("returns false when process.kill throws ESRCH (no such process)", async () => {
      const esrchError = Object.assign(new Error("no such process"), { code: "ESRCH" });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw esrchError;
      });
      try {
        const handle = pidHandle(999);
        expect(await isAgentProcessRunning(handle, "x")).toBe(false);
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  describe("edge cases", () => {
    it("returns false when handle has no id and no pid", async () => {
      const handle: RuntimeHandle = { id: "", runtimeName: "unknown", data: {} };
      expect(await isAgentProcessRunning(handle, "claude")).toBe(false);
    });

    it("returns false for tmux handle with empty id", async () => {
      // runtimeName is "tmux" but id is empty — should skip tmux path
      const handle: RuntimeHandle = { id: "", runtimeName: "tmux", data: {} };
      expect(await isAgentProcessRunning(handle, "claude")).toBe(false);
    });
  });
});
