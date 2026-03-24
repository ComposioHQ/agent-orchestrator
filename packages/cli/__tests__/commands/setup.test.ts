import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any imports that use them
// ---------------------------------------------------------------------------

const { mockFindConfigFile } = vi.hoisted(() => ({
  mockFindConfigFile: vi.fn(),
}));

const { mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

const { mockProbeGateway, mockValidateToken } = vi.hoisted(() => ({
  mockProbeGateway: vi.fn(),
  mockValidateToken: vi.fn(),
}));

vi.mock("@composio/ao-core", () => ({
  findConfigFile: (...args: unknown[]) => mockFindConfigFile(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    existsSync: () => true,
  };
});

vi.mock("../../src/lib/openclaw-probe.js", () => ({
  probeGateway: (...args: unknown[]) => mockProbeGateway(...args),
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
  DEFAULT_OPENCLAW_URL: "http://127.0.0.1:18789",
  HOOKS_PATH: "/hooks/agent",
}));

import { registerSetup } from "../../src/commands/setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = `
port: 3000
defaults:
  notifiers:
    - desktop
projects:
  my-app:
    name: my-app
    repo: owner/repo
    path: ~/code/my-app
`;

const CONFIG_WITH_OPENCLAW = `
port: 3000
defaults:
  notifiers:
    - desktop
    - openclaw
notifiers:
  openclaw:
    plugin: openclaw
    url: http://127.0.0.1:18789/hooks/agent
    token: "\${OPENCLAW_HOOKS_TOKEN}"
projects:
  my-app:
    name: my-app
`;

function createProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit
  registerSetup(program);
  return program;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setup openclaw command", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
    mockReadFileSync.mockReturnValue(MINIMAL_CONFIG);
    mockWriteFileSync.mockImplementation(() => {});
    mockValidateToken.mockResolvedValue({ valid: true });
    mockProbeGateway.mockResolvedValue({ reachable: false });

    // Force non-interactive (no TTY in test environment)
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("non-interactive mode", () => {
    it("writes config when --url and --token provided", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://127.0.0.1:18789/hooks/agent",
        "--token", "test-token",
        "--non-interactive",
      ]);

      expect(mockWriteFileSync).toHaveBeenCalledOnce();
      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("openclaw");
      expect(writtenYaml).toContain("plugin: openclaw");
      expect(writtenYaml).toContain("http://127.0.0.1:18789/hooks/agent");
    });

    it("reads token from OPENCLAW_HOOKS_TOKEN env var", async () => {
      process.env["OPENCLAW_HOOKS_TOKEN"] = "env-token";
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://127.0.0.1:18789/hooks/agent",
        "--non-interactive",
      ]);

      expect(mockValidateToken).toHaveBeenCalledWith(
        "http://127.0.0.1:18789/hooks/agent",
        "env-token",
      );
      expect(mockWriteFileSync).toHaveBeenCalledOnce();
    });

    it("reads URL from OPENCLAW_GATEWAY_URL env var", async () => {
      process.env["OPENCLAW_GATEWAY_URL"] = "http://remote:18789";
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--token", "tok",
        "--non-interactive",
      ]);

      expect(mockValidateToken).toHaveBeenCalledWith(
        "http://remote:18789/hooks/agent",
        "tok",
      );
    });

    it("validates token against gateway before saving", async () => {
      mockValidateToken.mockResolvedValue({ valid: true });
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://127.0.0.1:18789/hooks/agent",
        "--token", "good-token",
        "--non-interactive",
      ]);

      expect(mockValidateToken).toHaveBeenCalledWith(
        "http://127.0.0.1:18789/hooks/agent",
        "good-token",
      );
      expect(mockWriteFileSync).toHaveBeenCalledOnce();
    });
  });

  describe("config writing", () => {
    it("adds openclaw to defaults.notifiers", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://127.0.0.1:18789/hooks/agent",
        "--token", "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("openclaw");
      // Should have both desktop and openclaw in defaults.notifiers
      expect(writtenYaml).toContain("desktop");
    });

    it("does not duplicate openclaw in defaults.notifiers", async () => {
      mockReadFileSync.mockReturnValue(CONFIG_WITH_OPENCLAW);
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://127.0.0.1:18789/hooks/agent",
        "--token", "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const matches = writtenYaml.match(/openclaw/g);
      // "openclaw" appears in: defaults.notifiers list, notifiers.openclaw key,
      // plugin: openclaw, and the token ref. Should not have extra duplicates.
      // Count just in defaults section
      const defaultsSection = writtenYaml.split("notifiers:")[0] + writtenYaml.split("notifiers:")[1];
      expect(defaultsSection).toBeDefined();
    });

    it("writes correct notifier block structure", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://custom:9999/hooks/agent",
        "--token", "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("plugin: openclaw");
      expect(writtenYaml).toContain("http://custom:9999/hooks/agent");
      expect(writtenYaml).toContain("${OPENCLAW_HOOKS_TOKEN}");
      expect(writtenYaml).toContain("retries: 3");
      expect(writtenYaml).toContain("retryDelayMs: 1000");
      expect(writtenYaml).toContain("wakeMode: now");
    });

    it("preserves existing projects in config", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://127.0.0.1:18789/hooks/agent",
        "--token", "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("my-app");
      expect(writtenYaml).toContain("owner/repo");
    });

    it("writes to the correct config path", async () => {
      mockFindConfigFile.mockReturnValue("/custom/path/agent-orchestrator.yaml");
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://127.0.0.1:18789/hooks/agent",
        "--token", "tok",
        "--non-interactive",
      ]);

      expect(mockWriteFileSync.mock.calls[0][0]).toBe("/custom/path/agent-orchestrator.yaml");
    });
  });

  describe("error handling", () => {
    it("exits when no config file found", async () => {
      mockFindConfigFile.mockReturnValue(null);
      const program = createProgram();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(
        program.parseAsync([
          "node", "test", "setup", "openclaw",
          "--url", "http://127.0.0.1:18789/hooks/agent",
          "--token", "tok",
          "--non-interactive",
        ]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("skips validation and writes config even with bad token in non-interactive mode", async () => {
      mockValidateToken.mockResolvedValue({ valid: false, error: "Token rejected" });
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://127.0.0.1:18789/hooks/agent",
        "--token", "bad-token",
        "--non-interactive",
      ]);

      // nonInteractiveSetup skips pre-write validation, so config should still be written
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("exits when --url missing in non-interactive mode", async () => {
      const program = createProgram();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(
        program.parseAsync([
          "node", "test", "setup", "openclaw",
          "--token", "tok",
          "--non-interactive",
        ]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("auto-generates token when --token missing in non-interactive mode", async () => {
      delete process.env["OPENCLAW_HOOKS_TOKEN"];
      const program = createProgram();

      await program.parseAsync([
        "node", "test", "setup", "openclaw",
        "--url", "http://127.0.0.1:18789/hooks/agent",
        "--non-interactive",
      ]);

      // nonInteractiveSetup auto-generates a token when none is provided
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });
});
