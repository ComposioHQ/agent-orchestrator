import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockNotify, mockGetNotifier, mockLoadConfigFn } = vi.hoisted(() => ({
  mockNotify: vi.fn(),
  mockGetNotifier: vi.fn(),
  mockLoadConfigFn: vi.fn(),
}));

vi.mock("../../src/lib/plugins.js", () => ({
  getNotifier: mockGetNotifier,
}));

vi.mock("@composio/ao-core", () => ({
  loadConfig: mockLoadConfigFn,
}));

import { Command } from "commander";
import { registerNotify } from "../../src/commands/notify.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  program = new Command();
  program.exitOverride();
  registerNotify(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  mockNotify.mockReset();
  mockGetNotifier.mockReset();
  mockLoadConfigFn.mockReset();
});

afterEach(() => {
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
});

function makeConfig(overrides?: {
  notifiers?: Record<string, { plugin: string; [key: string]: unknown }>;
  notificationRouting?: Record<string, string[]>;
  defaults?: { notifiers?: string[] };
}) {
  return {
    dataDir: "/tmp",
    worktreeDir: "/tmp/wt",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: overrides?.defaults?.notifiers ?? ["desktop"],
    },
    projects: {
      app: { name: "app", repo: "org/app", path: "/app", defaultBranch: "main" },
    },
    notifiers: overrides?.notifiers ?? {
      desktop: { plugin: "desktop", sound: true },
    },
    notificationRouting: overrides?.notificationRouting ?? {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
  };
}

describe("notify test command", () => {
  it("exits with error when no config found", async () => {
    mockLoadConfigFn.mockImplementation(() => {
      throw new Error("no config");
    });

    await expect(
      program.parseAsync(["node", "test", "notify", "test"]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No config found"),
    );
  });

  it("exits with error for invalid priority", async () => {
    mockLoadConfigFn.mockReturnValue(makeConfig());

    await expect(
      program.parseAsync(["node", "test", "notify", "test", "-p", "bogus"]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid priority"),
    );
  });

  it("exits with error for unknown notifier name", async () => {
    mockLoadConfigFn.mockReturnValue(makeConfig());

    await expect(
      program.parseAsync(["node", "test", "notify", "test", "-n", "nonexistent"]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown notifier: "nonexistent"'),
    );
  });

  it("sends test notification to all routed notifiers", async () => {
    const config = makeConfig({
      notifiers: {
        desktop: { plugin: "desktop" },
        slack: { plugin: "slack", webhookUrl: "https://hooks.slack.com/test" },
      },
      notificationRouting: {
        urgent: ["desktop", "slack"],
        action: ["desktop"],
        warning: [],
        info: [],
      },
    });
    mockLoadConfigFn.mockReturnValue(config);

    mockGetNotifier.mockReturnValue({
      create: () => ({ name: "mock", notify: mockNotify }),
    });
    mockNotify.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "notify", "test"]);

    // Collects all unique notifiers across all routing levels: desktop + slack
    expect(mockGetNotifier).toHaveBeenCalledWith("desktop");
    expect(mockGetNotifier).toHaveBeenCalledWith("slack");
    expect(mockNotify).toHaveBeenCalledTimes(2);

    const event = mockNotify.mock.calls[0][0];
    expect(event.priority).toBe("action");
    expect(event.type).toBe("session.working");
    expect(event.message).toContain("test notification");
  });

  it("sends test notification to a specific notifier with -n flag", async () => {
    const config = makeConfig({
      notifiers: {
        desktop: { plugin: "desktop" },
        slack: { plugin: "slack", webhookUrl: "https://hooks.slack.com/test" },
      },
    });
    mockLoadConfigFn.mockReturnValue(config);

    mockGetNotifier.mockReturnValue({
      create: () => ({ name: "slack", notify: mockNotify }),
    });
    mockNotify.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "notify", "test", "-n", "slack"]);

    expect(mockGetNotifier).toHaveBeenCalledWith("slack");
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("respects the --priority flag", async () => {
    mockLoadConfigFn.mockReturnValue(makeConfig());

    mockGetNotifier.mockReturnValue({
      create: () => ({ name: "desktop", notify: mockNotify }),
    });
    mockNotify.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "notify", "test", "-p", "urgent"]);

    const event = mockNotify.mock.calls[0][0];
    expect(event.priority).toBe("urgent");
  });

  it("reports failure when notifier.notify throws", async () => {
    mockLoadConfigFn.mockReturnValue(makeConfig());

    mockGetNotifier.mockReturnValue({
      create: () => ({
        name: "desktop",
        notify: vi.fn().mockRejectedValue(new Error("connection refused")),
      }),
    });

    await program.parseAsync(["node", "test", "notify", "test"]);

    // Should show FAIL and the error message
    const failCall = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("FAIL"),
    );
    expect(failCall).toBeDefined();
    expect(failCall![0]).toContain("connection refused");
  });

  it("reports failure when plugin create throws", async () => {
    mockLoadConfigFn.mockReturnValue(makeConfig());

    mockGetNotifier.mockReturnValue({
      create: () => {
        throw new Error("invalid config");
      },
    });

    await program.parseAsync(["node", "test", "notify", "test"]);

    const failCall = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("FAIL"),
    );
    expect(failCall).toBeDefined();
    expect(failCall![0]).toContain("plugin error");
  });

  it("shows skip when notifier name is in routing but not in notifiers config", async () => {
    const config = makeConfig({
      notifiers: {},
      notificationRouting: {
        urgent: ["phantom"],
        action: ["phantom"],
        warning: [],
        info: [],
      },
      defaults: { notifiers: [] },
    });
    mockLoadConfigFn.mockReturnValue(config);

    await program.parseAsync(["node", "test", "notify", "test"]);

    const skipCall = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("skip"),
    );
    expect(skipCall).toBeDefined();
  });

  it("shows message when no notifiers are configured", async () => {
    const config = makeConfig({
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      defaults: { notifiers: [] },
    });
    mockLoadConfigFn.mockReturnValue(config);

    await program.parseAsync(["node", "test", "notify", "test"]);

    const noNotifierCall = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("No notifiers configured"),
    );
    expect(noNotifierCall).toBeDefined();
  });

  it("passes plugin-specific config to create()", async () => {
    const config = makeConfig({
      notifiers: {
        slack: { plugin: "slack", webhookUrl: "https://hooks.slack.com/test", channel: "#ops" },
      },
      notificationRouting: { urgent: [], action: ["slack"], warning: [], info: [] },
    });
    mockLoadConfigFn.mockReturnValue(config);

    const mockCreate = vi.fn().mockReturnValue({
      name: "slack",
      notify: mockNotify,
    });
    mockGetNotifier.mockReturnValue({ create: mockCreate });
    mockNotify.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "notify", "test"]);

    // create() should receive config without the "plugin" key
    expect(mockCreate).toHaveBeenCalledWith({
      webhookUrl: "https://hooks.slack.com/test",
      channel: "#ops",
    });
  });

  it("collects notifiers from defaults when routing is empty", async () => {
    const config = makeConfig({
      notifiers: {
        desktop: { plugin: "desktop" },
        slack: { plugin: "slack", webhookUrl: "https://hooks.slack.com/test" },
      },
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      defaults: { notifiers: ["desktop", "slack"] },
    });
    mockLoadConfigFn.mockReturnValue(config);

    mockGetNotifier.mockReturnValue({
      create: () => ({ name: "mock", notify: mockNotify }),
    });
    mockNotify.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "notify", "test"]);

    expect(mockGetNotifier).toHaveBeenCalledWith("desktop");
    expect(mockGetNotifier).toHaveBeenCalledWith("slack");
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });
});
