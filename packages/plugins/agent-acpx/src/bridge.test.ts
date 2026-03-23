import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpxBridge,
  buildEnsureSessionArgs,
  buildPromptArgs,
  composePrompt,
  DEFAULT_ACPX_AGENT,
  normalizeAcpxAgent,
  readSystemPrompt,
} from "./bridge.js";

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
}

describe("bridge helpers", () => {
  it("defaults acpx agent to pi", () => {
    expect(normalizeAcpxAgent(undefined)).toBe(DEFAULT_ACPX_AGENT);
  });

  it("rejects unsupported acpx agents", () => {
    expect(() => normalizeAcpxAgent("oracle")).toThrow("Unsupported acpx agent");
  });

  it("prepends system prompt when composing prompts", () => {
    expect(composePrompt("Fix the bug\n", "You are ACPX")).toBe("You are ACPX\n\nFix the bug");
  });

  it("builds supported acpx args for session ensure and prompt", () => {
    expect(buildEnsureSessionArgs({ acpxAgent: "pi" })).toEqual(["pi", "sessions", "ensure"]);
    expect(buildPromptArgs({ acpxAgent: "pi", prompt: "hello" })).toEqual(["pi", "prompt", "hello"]);
    expect(buildPromptArgs({ acpxAgent: "codex", prompt: "hello" })).toEqual(["codex", "prompt", "hello"]);
    expect(buildPromptArgs({ acpxAgent: "claude", prompt: "hello" })).toEqual(["claude", "prompt", "hello"]);
    expect(buildPromptArgs({ acpxAgent: "gemini", prompt: "hello" })).toEqual(["gemini", "prompt", "hello"]);
  });

  it("loads the system prompt from a file when provided", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "acpx-bridge-test-"));
    const file = join(dir, "prompt.md");
    await writeFile(file, "Use ACPX carefully", "utf-8");

    expect(readSystemPrompt({ systemPromptFile: file })).toBe("Use ACPX carefully");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("AcpxBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("batches stdin chunks into one multiline prompt", async () => {
    const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
    const spawnImpl = vi.fn((command: string, args: readonly string[], options: { cwd?: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      const child = new FakeChildProcess();
      setTimeout(() => {
        child.stdout.write("ok\n");
        child.emit("close", 0, null);
      }, 0);
      return child as never;
    });

    const stdout = new PassThrough();
    const bridge = new AcpxBridge({
      acpxAgent: "pi",
      cwd: "/workspace/test",
      systemPrompt: "System rules",
      spawnImpl,
      stdout,
    });

    bridge.acceptInput("Line one\nLine two");
    bridge.acceptInput("\n");
    await vi.advanceTimersByTimeAsync(150);
    await vi.runAllTimersAsync();
    await bridge.drain();

    expect(calls).toEqual([
      {
        command: "acpx",
        args: ["pi", "sessions", "ensure"],
        cwd: "/workspace/test",
      },
      {
        command: "acpx",
        args: ["pi", "prompt", "System rules\n\nLine one\nLine two"],
        cwd: "/workspace/test",
      },
    ]);
  });

  it("serializes queued prompts so only one acpx invocation runs at a time", async () => {
    const order: string[] = [];
    const spawnImpl = vi.fn((_command: string, args: readonly string[]) => {
      const child = new FakeChildProcess();
      order.push(`start:${args.join(' ')}`);
      setTimeout(() => {
        order.push(`end:${args.join(' ')}`);
        child.emit("close", 0, null);
      }, 5);
      return child as never;
    });

    const bridge = new AcpxBridge({ spawnImpl });
    bridge.acceptInput("first\n");
    await vi.advanceTimersByTimeAsync(150);
    bridge.acceptInput("second\n");
    await vi.advanceTimersByTimeAsync(150);
    await vi.runAllTimersAsync();
    await bridge.drain();

    expect(order).toEqual([
      "start:pi sessions ensure",
      "end:pi sessions ensure",
      "start:pi prompt first",
      "end:pi prompt first",
      "start:pi sessions ensure",
      "end:pi sessions ensure",
      "start:pi prompt second",
      "end:pi prompt second",
    ]);
  });

  it("keeps running after a failed acpx invocation", async () => {
    const stderr = new PassThrough();
    let attempt = 0;
    const spawnImpl = vi.fn(() => {
      attempt += 1;
      const child = new FakeChildProcess();
      setTimeout(() => {
        child.emit("close", attempt === 1 ? 1 : 0, null);
      }, 0);
      return child as never;
    });

    const bridge = new AcpxBridge({ spawnImpl, stderr });
    bridge.acceptInput("first\n");
    await vi.advanceTimersByTimeAsync(150);
    bridge.acceptInput("second\n");
    await vi.advanceTimersByTimeAsync(150);
    await vi.runAllTimersAsync();
    await bridge.drain();

    expect(stderr.read()?.toString("utf-8")).toContain("acpx pi failed with exit code 1");
    expect(spawnImpl).toHaveBeenCalledTimes(3);
  });

  it("does not send the prompt when session ensure fails", async () => {
    const calls: string[][] = [];
    const stderr = new PassThrough();
    const spawnImpl = vi.fn((_command: string, args: readonly string[]) => {
      calls.push([...args]);
      const child = new FakeChildProcess();
      setTimeout(() => {
        child.emit("close", 4, null);
      }, 0);
      return child as never;
    });

    const bridge = new AcpxBridge({ spawnImpl, stderr });
    bridge.acceptInput("hello\n");
    await vi.advanceTimersByTimeAsync(150);
    await vi.runAllTimersAsync();
    await bridge.drain();

    expect(calls).toEqual([["pi", "sessions", "ensure"]]);
    expect(stderr.read()?.toString("utf-8")).toContain("acpx pi failed with exit code 4");
  });
});
