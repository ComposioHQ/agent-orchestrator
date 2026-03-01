import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WebhookConfig } from "../src/config.js";

// Mock node:child_process with custom promisify support
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

// Mock node:fs
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { spawnCodingAgent, spawnTestGenAgent } from "../src/spawn.js";
import { reset } from "../src/dedup.js";

const mockExecFileCustom = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

function mockExecSuccess() {
  mockExecFileCustom.mockResolvedValueOnce({ stdout: "", stderr: "" });
}

function makeConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    port: 3200,
    webhookSecret: "secret",
    aoProjectId: "my-project",
    aoBin: "ao",
    dashboardTeamId: "team-id",
    triggerLabel: "agent-ready",
    dryRun: false,
    testGenPrompt: "# Write tests",
    ...overrides,
  };
}

beforeEach(() => {
  reset();
  vi.clearAllMocks();
});

describe("spawnCodingAgent", () => {
  it("calls ao spawn with project and identifier", async () => {
    mockExecSuccess();
    const config = makeConfig();
    await spawnCodingAgent("ENG-123", "Fix bug", config);
    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "ao",
      ["spawn", "my-project", "ENG-123"],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it("skips if recently spawned", async () => {
    mockExecSuccess();
    const config = makeConfig();
    // First call spawns
    await spawnCodingAgent("ENG-200", "First", config);
    // Second call should be skipped
    await spawnCodingAgent("ENG-200", "Second", config);
    expect(mockExecFileCustom).toHaveBeenCalledTimes(1);
  });

  it("in dry-run mode logs without executing", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = makeConfig({ dryRun: true });
    await spawnCodingAgent("ENG-301", "Dry run test", config);
    expect(mockExecFileCustom).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[DRY_RUN]"));
    consoleSpy.mockRestore();
  });
});

describe("spawnTestGenAgent", () => {
  it("writes prompt to temp file and calls ao spawn with --prompt", async () => {
    mockExecSuccess();
    const config = makeConfig();
    await spawnTestGenAgent("ENG-400", "Add tests", config);

    const writeCall = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(writeCall[0]).toMatch(/\/tmp\/ao-testgen-ENG-400\.md/);
    expect(writeCall[1]).toContain("# Write tests");
    expect(writeCall[1]).toContain("ENG-400");

    expect(mockExecFileCustom).toHaveBeenCalledWith(
      "ao",
      ["spawn", "my-project", "ENG-400", "--prompt", expect.stringContaining("ENG-400")],
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it("skips if recently spawned", async () => {
    mockExecSuccess();
    const config = makeConfig();
    await spawnTestGenAgent("ENG-500", "First", config);
    await spawnTestGenAgent("ENG-500", "Second", config);
    expect(mockExecFileCustom).toHaveBeenCalledTimes(1);
  });

  it("cleans up temp file after spawn", async () => {
    mockExecSuccess();
    const config = makeConfig();
    await spawnTestGenAgent("ENG-600", "Cleanup test", config);
    const unlinkCalls = (fs.unlinkSync as ReturnType<typeof vi.fn>).mock.calls;
    expect(unlinkCalls.length).toBeGreaterThan(0);
    expect(unlinkCalls[0][0]).toMatch(/\/tmp\/ao-testgen-ENG-600\.md/);
  });
});
