import { describe, it, expect, beforeEach, vi } from "vitest";
import { reset, markSpawned, entries } from "../src/dedup.js";
import type { WebhookConfig } from "../src/config.js";

// Mock child_process.execFile — promisify will wrap this
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: "", stderr: "" });
    },
  ),
}));

// Mock fs functions used by spawnTestGenAgent
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocks are set up
import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { spawnCodingAgent, spawnTestGenAgent } from "../src/spawn.js";

const execFileMock = vi.mocked(execFile);
const writeFileSyncMock = vi.mocked(writeFileSync);
const unlinkSyncMock = vi.mocked(unlinkSync);

const testConfig: WebhookConfig = {
  port: 3100,
  webhookSecret: "test-secret",
  aoProjectId: "dashboard",
  aoBin: "/usr/local/bin/ao",
  dashboardTeamId: "test-team-id",
  triggerLabel: "agent-ready",
  dryRun: false,
  testGenPrompt: "# Test Gen Instructions\nWrite tests.",
};

describe("spawnCodingAgent", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
    // Restore default success behavior
    execFileMock.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (typeof _opts === "function") {
          (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void)(
            null,
            { stdout: "", stderr: "" },
          );
        } else if (cb) {
          cb(null, { stdout: "", stderr: "" });
        }
        return undefined as never;
      },
    );
  });

  it("calls execFile with correct args", async () => {
    await spawnCodingAgent("DASH-42", "Fix the bug", testConfig);

    expect(execFileMock).toHaveBeenCalledWith(
      "/usr/local/bin/ao",
      ["spawn", "dashboard", "DASH-42"],
      { timeout: 30_000 },
      expect.any(Function),
    );
  });

  it("skips if recently spawned", async () => {
    markSpawned("DASH-42", "code");

    await spawnCodingAgent("DASH-42", "Fix the bug", testConfig);

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("in dry-run mode, logs but does not call execFile", async () => {
    const dryConfig = { ...testConfig, dryRun: true };
    const consoleSpy = vi.spyOn(console, "log");

    await spawnCodingAgent("DASH-42", "Fix the bug", dryConfig);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[DRY_RUN]"));
    consoleSpy.mockRestore();
  });

  it("marks as spawned after successful execution", async () => {
    await spawnCodingAgent("DASH-42", "Fix the bug", testConfig);

    expect(entries().has("DASH-42:code")).toBe(true);
  });

  it("does NOT mark as spawned on execFile failure", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const err = new Error("Command failed");
        if (typeof _opts === "function") {
          (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void)(err, {
            stdout: "",
            stderr: "",
          });
        } else if (cb) {
          cb(err, { stdout: "", stderr: "" });
        }
        return undefined as never;
      },
    );

    await spawnCodingAgent("DASH-42", "Fix the bug", testConfig);

    expect(entries().has("DASH-42:code")).toBe(false);
  });
});

describe("spawnTestGenAgent", () => {
  beforeEach(() => {
    reset();
    vi.clearAllMocks();
    // Restore default success behavior
    execFileMock.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (typeof _opts === "function") {
          (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void)(
            null,
            { stdout: "", stderr: "" },
          );
        } else if (cb) {
          cb(null, { stdout: "", stderr: "" });
        }
        return undefined as never;
      },
    );
  });

  it("calls writeFileSync with prompt content then execFile with --prompt flag", async () => {
    await spawnTestGenAgent("DASH-42", "Fix the bug", testConfig);

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      "/tmp/ao-testgen-DASH-42.md",
      expect.stringContaining("# Test Gen Instructions"),
      "utf-8",
    );

    expect(execFileMock).toHaveBeenCalledWith(
      "/usr/local/bin/ao",
      ["spawn", "dashboard", "DASH-42", "--prompt", "/tmp/ao-testgen-DASH-42.md"],
      { timeout: 30_000 },
      expect.any(Function),
    );
  });

  it("cleans up temp file after successful spawn", async () => {
    await spawnTestGenAgent("DASH-42", "Fix the bug", testConfig);

    expect(unlinkSyncMock).toHaveBeenCalledWith("/tmp/ao-testgen-DASH-42.md");
  });

  it("cleans up temp file even on execFile failure", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const err = new Error("Command failed");
        if (typeof _opts === "function") {
          (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void)(err, {
            stdout: "",
            stderr: "",
          });
        } else if (cb) {
          cb(err, { stdout: "", stderr: "" });
        }
        return undefined as never;
      },
    );

    await spawnTestGenAgent("DASH-42", "Fix the bug", testConfig);

    expect(unlinkSyncMock).toHaveBeenCalledWith("/tmp/ao-testgen-DASH-42.md");
  });

  it("skips if recently spawned", async () => {
    markSpawned("DASH-42", "test-gen");

    await spawnTestGenAgent("DASH-42", "Fix the bug", testConfig);

    expect(execFileMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it("prompt file contains testGenPrompt and issue details", async () => {
    await spawnTestGenAgent("DASH-42", "Fix the bug", testConfig);

    const writtenContent = writeFileSyncMock.mock.calls[0]![1] as string;
    expect(writtenContent).toContain("# Test Gen Instructions");
    expect(writtenContent).toContain("Write tests.");
    expect(writtenContent).toContain("Issue: DASH-42");
    expect(writtenContent).toContain("Title: Fix the bug");
    expect(writtenContent).toContain(
      "Generate tests for the changes introduced by this issue.",
    );
  });

  it("marks as spawned after successful execution", async () => {
    await spawnTestGenAgent("DASH-42", "Fix the bug", testConfig);

    expect(entries().has("DASH-42:test-gen")).toBe(true);
  });

  it("does NOT mark as spawned on execFile failure", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const err = new Error("Command failed");
        if (typeof _opts === "function") {
          (_opts as (err: Error | null, result: { stdout: string; stderr: string }) => void)(err, {
            stdout: "",
            stderr: "",
          });
        } else if (cb) {
          cb(err, { stdout: "", stderr: "" });
        }
        return undefined as never;
      },
    );

    await spawnTestGenAgent("DASH-42", "Fix the bug", testConfig);

    expect(entries().has("DASH-42:test-gen")).toBe(false);
  });
});
