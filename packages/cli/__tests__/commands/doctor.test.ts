import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const {
  mockRunRepoScript,
  mockFindConfigFile,
  mockLoadConfig,
  mockProbeGateway,
  mockValidateToken,
  mockCreatePluginRegistry,
  mockNotifier,
} = vi.hoisted(() => ({
  mockRunRepoScript: vi.fn(),
  mockFindConfigFile: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockProbeGateway: vi.fn(),
  mockValidateToken: vi.fn(),
  mockCreatePluginRegistry: vi.fn(),
  mockNotifier: {
    notify: vi.fn(),
  },
}));

vi.mock("../../src/lib/script-runner.js", () => ({
  runRepoScript: (...args: unknown[]) => mockRunRepoScript(...args),
}));

vi.mock("@composio/ao-core", () => ({
  findConfigFile: (...args: unknown[]) => mockFindConfigFile(...args),
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  createPluginRegistry: (...args: unknown[]) => mockCreatePluginRegistry(...args),
}));

vi.mock("../../src/lib/openclaw-probe.js", () => ({
  probeGateway: (...args: unknown[]) => mockProbeGateway(...args),
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
}));

import { registerDoctor } from "../../src/commands/doctor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {},
    notifiers: {},
    notificationRouting: {},
    reactions: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — existing basic behavior
// ---------------------------------------------------------------------------

describe("doctor command", () => {
  let program: Command;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerDoctor(program);

    mockRunRepoScript.mockReset();
    mockRunRepoScript.mockResolvedValue(0);
    mockFindConfigFile.mockReset();
    mockFindConfigFile.mockReturnValue(null);
    mockLoadConfig.mockReset();
    mockProbeGateway.mockReset();
    mockValidateToken.mockReset();
    mockCreatePluginRegistry.mockReset();
    mockNotifier.notify.mockReset();

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the doctor script with no extra args by default", async () => {
    await program.parseAsync(["node", "test", "doctor"]);

    expect(mockRunRepoScript).toHaveBeenCalledWith("ao-doctor.sh", []);
  });

  it("passes through --fix", async () => {
    await program.parseAsync(["node", "test", "doctor", "--fix"]);

    expect(mockRunRepoScript).toHaveBeenCalledWith("ao-doctor.sh", ["--fix"]);
  });

  // -------------------------------------------------------------------------
  // Notifier connectivity checks
  // -------------------------------------------------------------------------

  describe("notifier connectivity", () => {
    it("checks OpenClaw notifier when configured", async () => {
      const config = makeConfig({
        notifiers: {
          openclaw: {
            plugin: "openclaw",
            url: "http://127.0.0.1:18789",
            token: "my-token",
          },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);
      mockProbeGateway.mockResolvedValue({ reachable: true, httpStatus: 200 });
      mockValidateToken.mockResolvedValue({ valid: true });

      await program.parseAsync(["node", "test", "doctor"]);

      expect(mockProbeGateway).toHaveBeenCalledWith("http://127.0.0.1:18789");
      expect(mockValidateToken).toHaveBeenCalledWith("http://127.0.0.1:18789", "my-token");

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("PASS");
      expect(output).toContain("reachable");
      expect(output).toContain("token is valid");
    });

    it("reports FAIL when OpenClaw gateway is not reachable", async () => {
      const config = makeConfig({
        notifiers: {
          openclaw: {
            plugin: "openclaw",
            url: "http://127.0.0.1:18789",
            token: "my-token",
          },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);
      mockProbeGateway.mockResolvedValue({ reachable: false });

      await expect(
        program.parseAsync(["node", "test", "doctor"]),
      ).rejects.toThrow("process.exit");

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("FAIL");
      expect(output).toContain("not reachable");
    });

    it("reports FAIL when OpenClaw token validation fails", async () => {
      const config = makeConfig({
        notifiers: {
          openclaw: {
            plugin: "openclaw",
            url: "http://127.0.0.1:18789",
            token: "bad-token",
          },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);
      mockProbeGateway.mockResolvedValue({ reachable: true, httpStatus: 200 });
      mockValidateToken.mockResolvedValue({ valid: false, error: "Token rejected" });

      await expect(
        program.parseAsync(["node", "test", "doctor"]),
      ).rejects.toThrow("process.exit");

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("FAIL");
      expect(output).toContain("Token rejected");
    });

    it("warns when OpenClaw token is not set", async () => {
      const config = makeConfig({
        notifiers: {
          openclaw: {
            plugin: "openclaw",
            url: "http://127.0.0.1:18789",
            // no token
          },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);
      mockProbeGateway.mockResolvedValue({ reachable: true, httpStatus: 200 });

      await program.parseAsync(["node", "test", "doctor"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("WARN");
      expect(output).toContain("token is not set");
    });

    it("warns when OpenClaw notifier is not configured", async () => {
      const config = makeConfig({
        notifiers: {},
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);

      await program.parseAsync(["node", "test", "doctor"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("WARN");
      expect(output).toContain("No notifiers are configured");
    });

    it("reports other configured notifiers as present", async () => {
      const config = makeConfig({
        notifiers: {
          slack: { plugin: "slack" },
          desktop: { plugin: "desktop" },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);

      await program.parseAsync(["node", "test", "doctor"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("PASS");
      expect(output).toContain("slack");
      expect(output).toContain("desktop");
    });

    it("resolves env var placeholder in token", async () => {
      const originalEnv = process.env["OPENCLAW_HOOKS_TOKEN"];
      process.env["OPENCLAW_HOOKS_TOKEN"] = "env-resolved-token";

      const config = makeConfig({
        notifiers: {
          openclaw: {
            plugin: "openclaw",
            url: "http://127.0.0.1:18789",
            token: "${OPENCLAW_HOOKS_TOKEN}",
          },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);
      mockProbeGateway.mockResolvedValue({ reachable: true, httpStatus: 200 });
      mockValidateToken.mockResolvedValue({ valid: true });

      await program.parseAsync(["node", "test", "doctor"]);

      expect(mockValidateToken).toHaveBeenCalledWith(
        "http://127.0.0.1:18789",
        "env-resolved-token",
      );

      // Restore
      if (originalEnv === undefined) {
        delete process.env["OPENCLAW_HOOKS_TOKEN"];
      } else {
        process.env["OPENCLAW_HOOKS_TOKEN"] = originalEnv;
      }
    });

    it("uses default URL when OpenClaw notifier has no URL set", async () => {
      const config = makeConfig({
        notifiers: {
          openclaw: {
            plugin: "openclaw",
            // no url — should default to http://127.0.0.1:18789
            token: "my-token",
          },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);
      mockProbeGateway.mockResolvedValue({ reachable: true, httpStatus: 200 });
      mockValidateToken.mockResolvedValue({ valid: true });

      await program.parseAsync(["node", "test", "doctor"]);

      expect(mockProbeGateway).toHaveBeenCalledWith("http://127.0.0.1:18789");
    });

    it("skips notifier check when notifier plugin is not openclaw", async () => {
      const config = makeConfig({
        notifiers: {
          openclaw: {
            plugin: "something-else", // not "openclaw"
          },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);

      await program.parseAsync(["node", "test", "doctor"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("WARN");
      expect(output).toContain("OpenClaw notifier is not configured");
      expect(mockProbeGateway).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // --test-notify
  // -------------------------------------------------------------------------

  describe("--test-notify", () => {
    it("sends test notifications to all configured notifiers", async () => {
      // Use a non-openclaw notifier to avoid the connectivity check adding a fail
      const config = makeConfig({
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: ["desktop"],
        },
        notifiers: {
          desktop: { plugin: "desktop" },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);

      const mockRegistry = {
        loadFromConfig: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockReturnValue(mockNotifier),
      };
      mockCreatePluginRegistry.mockReturnValue(mockRegistry);
      mockNotifier.notify.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "doctor", "--test-notify"]);

      expect(mockNotifier.notify).toHaveBeenCalled();
      const notifyCall = mockNotifier.notify.mock.calls[0][0];
      expect(notifyCall.type).toBe("summary.all_complete");
      expect(notifyCall.message).toContain("Test notification");

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("PASS");
      expect(output).toContain("test notification sent");
    });

    it("reports FAIL when a notifier throws on notify", async () => {
      const config = makeConfig({
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: ["broken"],
        },
        notifiers: {
          broken: { plugin: "broken" },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);

      const brokenNotifier = {
        notify: vi.fn().mockRejectedValue(new Error("Connection refused")),
      };
      const mockRegistry = {
        loadFromConfig: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockReturnValue(brokenNotifier),
      };
      mockCreatePluginRegistry.mockReturnValue(mockRegistry);

      await expect(
        program.parseAsync(["node", "test", "doctor", "--test-notify"]),
      ).rejects.toThrow("process.exit");

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("FAIL");
      expect(output).toContain("Connection refused");
    });

    it("warns when notifier plugin is not loaded", async () => {
      const config = makeConfig({
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: ["missing"],
        },
        notifiers: {
          missing: { plugin: "missing" },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);

      const mockRegistry = {
        loadFromConfig: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockReturnValue(null), // not loaded
      };
      mockCreatePluginRegistry.mockReturnValue(mockRegistry);

      await program.parseAsync(["node", "test", "doctor", "--test-notify"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("WARN");
      expect(output).toContain("not loaded");
    });

    it("warns when no notifiers to test", async () => {
      const config = makeConfig({
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: [],
        },
        notifiers: {},
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);

      const mockRegistry = {
        loadFromConfig: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockReturnValue(null),
      };
      mockCreatePluginRegistry.mockReturnValue(mockRegistry);

      await program.parseAsync(["node", "test", "doctor", "--test-notify"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("WARN");
      expect(output).toContain("No notifiers to test");
    });

    it("fails when --test-notify is used without config file", async () => {
      mockFindConfigFile.mockReturnValue(null);

      await expect(
        program.parseAsync(["node", "test", "doctor", "--test-notify"]),
      ).rejects.toThrow("process.exit");

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("FAIL");
      expect(output).toContain("No config file found");
    });

    it("deduplicates notifier names from defaults and configured", async () => {
      // Use non-openclaw notifiers to avoid connectivity check failures
      const config = makeConfig({
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: ["desktop", "slack"],
        },
        notifiers: {
          desktop: { plugin: "desktop" },
          slack: { plugin: "slack" },
        },
      });
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockReturnValue(config);

      const mockRegistry = {
        loadFromConfig: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockReturnValue(mockNotifier),
      };
      mockCreatePluginRegistry.mockReturnValue(mockRegistry);
      mockNotifier.notify.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "doctor", "--test-notify"]);

      // Should only notify twice (desktop + slack), not four times
      expect(mockNotifier.notify).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Shell script error handling
  // -------------------------------------------------------------------------

  describe("shell script errors", () => {
    it("exits non-zero when shell script fails", async () => {
      mockRunRepoScript.mockResolvedValue(1);

      await expect(
        program.parseAsync(["node", "test", "doctor"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("handles shell script throwing an error", async () => {
      mockRunRepoScript.mockRejectedValue(new Error("Script not found"));

      await expect(
        program.parseAsync(["node", "test", "doctor"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("handles loadConfig throwing during notifier check", async () => {
      mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
      mockLoadConfig.mockImplementation(() => {
        throw new Error("Invalid YAML");
      });

      // Should still succeed (shell checks pass, loadConfig error is warned)
      await program.parseAsync(["node", "test", "doctor"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("WARN");
    });
  });
});
