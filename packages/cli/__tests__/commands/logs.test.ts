import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockReadLogs, mockReadLogsFromDir, mockTailLogs, mockResolveLogDir } = vi.hoisted(() => ({
  mockReadLogs: vi.fn(),
  mockReadLogsFromDir: vi.fn(),
  mockTailLogs: vi.fn(),
  mockResolveLogDir: vi.fn(),
}));

vi.mock("@composio/ao-core", () => ({
  readLogs: mockReadLogs,
  readLogsFromDir: mockReadLogsFromDir,
  tailLogs: mockTailLogs,
}));

vi.mock("../../src/lib/perf-utils.js", () => ({
  resolveLogDir: mockResolveLogDir,
}));

vi.mock("../../src/lib/format.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../../src/lib/format.js")>();
  return { ...actual };
});

import { Command } from "commander";
import { registerLogs } from "../../src/commands/logs.js";

let program: Command;
let logs: string[];

beforeEach(() => {
  program = new Command();
  program.exitOverride();
  registerLogs(program);

  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockReadLogs.mockReset();
  mockReadLogsFromDir.mockReset();
  mockTailLogs.mockReset();
  mockResolveLogDir.mockReset();
  mockResolveLogDir.mockReturnValue("/tmp/logs");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logs dashboard", () => {
  it("calls tailLogs with correct args when using --tail", async () => {
    mockTailLogs.mockReturnValue([
      {
        ts: "2025-01-01T12:00:00Z",
        level: "info",
        source: "dashboard",
        sessionId: null,
        message: "Server started",
      },
    ]);

    await program.parseAsync(["node", "test", "logs", "dashboard", "--tail", "20"]);

    expect(mockTailLogs).toHaveBeenCalledWith(
      expect.stringContaining("dashboard.jsonl"),
      20,
    );
    const output = logs.join("\n");
    expect(output).toContain("Server started");
  });

  it("calls readLogs with a since Date when using --since", async () => {
    mockReadLogs.mockReturnValue([]);

    await program.parseAsync(["node", "test", "logs", "dashboard", "--since", "1h"]);

    expect(mockReadLogs).toHaveBeenCalledWith(
      expect.stringContaining("dashboard.jsonl"),
      expect.objectContaining({
        since: expect.any(Date),
      }),
    );
  });

  it("shows 'No log entries found.' when empty", async () => {
    mockTailLogs.mockReturnValue([]);

    await program.parseAsync(["node", "test", "logs", "dashboard"]);

    const output = logs.join("\n");
    expect(output).toContain("No log entries found.");
  });

  it("outputs JSON with --json flag", async () => {
    const entries = [
      {
        ts: "2025-01-01T12:00:00Z",
        level: "info" as const,
        source: "dashboard" as const,
        sessionId: null,
        message: "test entry",
      },
    ];
    mockTailLogs.mockReturnValue(entries);

    await program.parseAsync(["node", "test", "logs", "dashboard", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].message).toBe("test entry");
  });
});

describe("logs events", () => {
  it("calls readLogsFromDir with 'events' prefix", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    await program.parseAsync(["node", "test", "logs", "events"]);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/logs",
      "events",
      expect.objectContaining({ source: "lifecycle" }),
    );
  });

  it("passes sessionId filter with --session", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    await program.parseAsync(["node", "test", "logs", "events", "--session", "sess-1"]);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/logs",
      "events",
      expect.objectContaining({ sessionId: "sess-1", source: "lifecycle" }),
    );
  });

  it("shows empty message when no events found", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    await program.parseAsync(["node", "test", "logs", "events"]);

    const output = logs.join("\n");
    expect(output).toContain("No log entries found.");
  });

  it("outputs JSON with --json flag", async () => {
    const entries = [
      {
        ts: "2025-01-01T12:00:00Z",
        level: "info" as const,
        source: "lifecycle" as const,
        sessionId: "sess-1",
        message: "state changed",
      },
    ];
    mockReadLogsFromDir.mockReturnValue(entries);

    await program.parseAsync(["node", "test", "logs", "events", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBe("sess-1");
  });
});

describe("logs session", () => {
  it("calls readLogsFromDir with sessionId", async () => {
    mockReadLogsFromDir.mockReturnValue([
      {
        ts: "2025-01-01T12:00:00Z",
        level: "info",
        source: "lifecycle",
        sessionId: "myid",
        message: "spawned",
      },
    ]);

    await program.parseAsync(["node", "test", "logs", "session", "myid"]);

    expect(mockReadLogsFromDir).toHaveBeenCalledWith(
      "/tmp/logs",
      "events",
      expect.objectContaining({ sessionId: "myid" }),
    );
  });

  it("shows message when no events found for session", async () => {
    mockReadLogsFromDir.mockReturnValue([]);

    await program.parseAsync(["node", "test", "logs", "session", "unknown-id"]);

    const output = logs.join("\n");
    expect(output).toContain("No log entries found.");
  });

  it("outputs JSON with --json flag", async () => {
    const entries = [
      {
        ts: "2025-01-01T12:00:00Z",
        level: "info" as const,
        source: "lifecycle" as const,
        sessionId: "myid",
        message: "spawned",
      },
    ];
    mockReadLogsFromDir.mockReturnValue(entries);

    await program.parseAsync(["node", "test", "logs", "session", "myid", "--json"]);

    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBe("myid");
  });
});
