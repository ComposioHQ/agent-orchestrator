import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockLoadConfig, mockCreatePluginRegistry, mockTracker } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockCreatePluginRegistry: vi.fn(),
  mockTracker: {
    listIssues: vi.fn(),
    updateIssue: vi.fn(),
  },
}));

vi.mock("@composio/ao-core", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  createPluginRegistry: (...args: unknown[]) => mockCreatePluginRegistry(...args),
}));

import { registerVerify } from "../../src/commands/verify.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(projects: Record<string, unknown> = {}) {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects,
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };
}

function singleProjectConfig(trackerPlugin = "linear") {
  return createConfig({
    "my-app": {
      name: "My App",
      repo: "org/my-app",
      path: "/code/my-app",
      tracker: { plugin: trackerPlugin },
    },
  });
}

function multiProjectConfig() {
  return createConfig({
    "my-app": {
      name: "My App",
      repo: "org/my-app",
      path: "/code/my-app",
      tracker: { plugin: "linear" },
    },
    docs: {
      name: "Docs",
      repo: "org/docs",
      path: "/code/docs",
      tracker: { plugin: "linear" },
    },
  });
}

function noTrackerConfig() {
  return createConfig({
    "my-app": {
      name: "My App",
      repo: "org/my-app",
      path: "/code/my-app",
      // no tracker
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verify command", () => {
  let program: Command;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerVerify(program);

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    mockLoadConfig.mockReset();
    mockCreatePluginRegistry.mockReset();
    mockTracker.listIssues.mockReset();
    mockTracker.updateIssue.mockReset();

    // Default: single project with tracker
    mockLoadConfig.mockReturnValue(singleProjectConfig());

    // Default: registry returns the mock tracker
    const mockRegistry = {
      loadFromConfig: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue(mockTracker),
    };
    mockCreatePluginRegistry.mockReturnValue(mockRegistry);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Config loading errors
  // -------------------------------------------------------------------------

  describe("config errors", () => {
    it("exits when no config is found", async () => {
      mockLoadConfig.mockImplementation(() => {
        throw new Error("Config not found");
      });

      await expect(
        program.parseAsync(["node", "test", "verify", "INT-100"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // Project resolution
  // -------------------------------------------------------------------------

  describe("project resolution", () => {
    it("auto-resolves when only one project exists", async () => {
      mockTracker.updateIssue.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "verify", "INT-100"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("INT-100");
      expect(output).toContain("verified");
    });

    it("resolves project with --project flag", async () => {
      mockLoadConfig.mockReturnValue(multiProjectConfig());
      mockTracker.updateIssue.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "verify", "INT-100", "--project", "my-app"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("INT-100");
    });

    it("exits when --project references unknown project", async () => {
      mockLoadConfig.mockReturnValue(multiProjectConfig());

      await expect(
        program.parseAsync(["node", "test", "verify", "INT-100", "--project", "nonexistent"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when multiple projects and no --project flag", async () => {
      mockLoadConfig.mockReturnValue(multiProjectConfig());

      await expect(
        program.parseAsync(["node", "test", "verify", "INT-100"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when no projects configured", async () => {
      mockLoadConfig.mockReturnValue(createConfig({}));

      await expect(
        program.parseAsync(["node", "test", "verify", "INT-100"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tracker resolution
  // -------------------------------------------------------------------------

  describe("tracker errors", () => {
    it("exits when project has no tracker configured", async () => {
      mockLoadConfig.mockReturnValue(noTrackerConfig());

      await expect(
        program.parseAsync(["node", "test", "verify", "INT-100"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when tracker plugin is not found in registry", async () => {
      const mockRegistry = {
        loadFromConfig: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockReturnValue(null), // plugin not found
      };
      mockCreatePluginRegistry.mockReturnValue(mockRegistry);

      await expect(
        program.parseAsync(["node", "test", "verify", "INT-100"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // --list mode
  // -------------------------------------------------------------------------

  describe("--list mode", () => {
    it("lists merged-unverified issues", async () => {
      mockTracker.listIssues.mockResolvedValue([
        {
          id: "INT-100",
          title: "Fix login bug",
          labels: ["merged-unverified"],
          url: "https://linear.app/INT-100",
        },
        {
          id: "INT-200",
          title: "Update README",
          labels: ["merged-unverified", "docs"],
          url: null,
        },
      ]);

      await program.parseAsync(["node", "test", "verify", "--list"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("INT-100");
      expect(output).toContain("Fix login bug");
      expect(output).toContain("INT-200");
      expect(output).toContain("Update README");
      expect(output).toContain("2 issues awaiting verification");
    });

    it("shows singular when only one issue", async () => {
      mockTracker.listIssues.mockResolvedValue([
        { id: "INT-100", title: "Fix bug", labels: ["merged-unverified"], url: null },
      ]);

      await program.parseAsync(["node", "test", "verify", "--list"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("1 issue awaiting verification");
    });

    it("shows message when no issues found", async () => {
      mockTracker.listIssues.mockResolvedValue([]);

      await program.parseAsync(["node", "test", "verify", "--list"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No merged-unverified issues found");
    });

    it("exits when tracker does not support listIssues", async () => {
      const trackerWithoutList = { updateIssue: vi.fn() };
      const mockRegistry = {
        loadFromConfig: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockReturnValue(trackerWithoutList),
      };
      mockCreatePluginRegistry.mockReturnValue(mockRegistry);

      await expect(
        program.parseAsync(["node", "test", "verify", "--list"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("shows issue URL when available", async () => {
      mockTracker.listIssues.mockResolvedValue([
        {
          id: "INT-100",
          title: "Fix bug",
          labels: ["merged-unverified"],
          url: "https://linear.app/INT-100",
        },
      ]);

      await program.parseAsync(["node", "test", "verify", "--list"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("https://linear.app/INT-100");
    });

    it("shows labels alongside issue title", async () => {
      mockTracker.listIssues.mockResolvedValue([
        {
          id: "INT-100",
          title: "Fix bug",
          labels: ["merged-unverified", "critical"],
          url: null,
        },
      ]);

      await program.parseAsync(["node", "test", "verify", "--list"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("merged-unverified");
      expect(output).toContain("critical");
    });

    it("shows no labels when labels array is empty", async () => {
      mockTracker.listIssues.mockResolvedValue([
        { id: "INT-100", title: "Fix bug", labels: [], url: null },
      ]);

      await program.parseAsync(["node", "test", "verify", "--list"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("INT-100");
      expect(output).toContain("Fix bug");
    });

    it("uses project name in header", async () => {
      mockTracker.listIssues.mockResolvedValue([
        { id: "INT-100", title: "Fix bug", labels: ["merged-unverified"], url: null },
      ]);

      await program.parseAsync(["node", "test", "verify", "--list"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("My App");
    });

    it("uses project ID in header when project has no name", async () => {
      mockLoadConfig.mockReturnValue(
        createConfig({
          "my-app": {
            repo: "org/my-app",
            path: "/code/my-app",
            tracker: { plugin: "linear" },
          },
        }),
      );

      mockTracker.listIssues.mockResolvedValue([
        { id: "INT-100", title: "Fix bug", labels: ["merged-unverified"], url: null },
      ]);

      await program.parseAsync(["node", "test", "verify", "--list"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("my-app");
    });
  });

  // -------------------------------------------------------------------------
  // Verify action (default — mark as passed)
  // -------------------------------------------------------------------------

  describe("verify (pass)", () => {
    it("marks issue as verified and closed with default comment", async () => {
      mockTracker.updateIssue.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "verify", "INT-100"]);

      expect(mockTracker.updateIssue).toHaveBeenCalledWith(
        "INT-100",
        {
          state: "closed",
          labels: ["verified"],
          removeLabels: ["merged-unverified"],
          comment: "Verified — fix confirmed on staging.",
        },
        expect.anything(),
      );

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("INT-100");
      expect(output).toContain("verified and closed");
    });

    it("uses custom comment when --comment is provided", async () => {
      mockTracker.updateIssue.mockResolvedValue(undefined);

      await program.parseAsync([
        "node",
        "test",
        "verify",
        "INT-100",
        "--comment",
        "Tested manually on staging.",
      ]);

      expect(mockTracker.updateIssue).toHaveBeenCalledWith(
        "INT-100",
        expect.objectContaining({
          comment: "Tested manually on staging.",
        }),
        expect.anything(),
      );

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Tested manually on staging.");
    });

    it("exits when no issue argument is provided", async () => {
      await expect(
        program.parseAsync(["node", "test", "verify"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits when tracker does not support updateIssue", async () => {
      const trackerWithoutUpdate = { listIssues: vi.fn() };
      const mockRegistry = {
        loadFromConfig: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockReturnValue(trackerWithoutUpdate),
      };
      mockCreatePluginRegistry.mockReturnValue(mockRegistry);

      await expect(
        program.parseAsync(["node", "test", "verify", "INT-100"]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // -------------------------------------------------------------------------
  // --fail mode
  // -------------------------------------------------------------------------

  describe("verify --fail", () => {
    it("marks issue as verification-failed with default comment", async () => {
      mockTracker.updateIssue.mockResolvedValue(undefined);

      await program.parseAsync(["node", "test", "verify", "INT-100", "--fail"]);

      expect(mockTracker.updateIssue).toHaveBeenCalledWith(
        "INT-100",
        {
          state: "open",
          labels: ["verification-failed"],
          removeLabels: ["merged-unverified"],
          comment: "Verification failed — problem persists on staging.",
        },
        expect.anything(),
      );

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("INT-100");
      expect(output).toContain("verification-failed");
    });

    it("uses custom comment with --fail and --comment", async () => {
      mockTracker.updateIssue.mockResolvedValue(undefined);

      await program.parseAsync([
        "node",
        "test",
        "verify",
        "INT-100",
        "--fail",
        "--comment",
        "Still broken on staging. See screenshot.",
      ]);

      expect(mockTracker.updateIssue).toHaveBeenCalledWith(
        "INT-100",
        expect.objectContaining({
          state: "open",
          comment: "Still broken on staging. See screenshot.",
        }),
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // --project with verify/fail
  // -------------------------------------------------------------------------

  describe("--project with verify actions", () => {
    it("resolves project from --project flag in multi-project config", async () => {
      mockLoadConfig.mockReturnValue(multiProjectConfig());
      mockTracker.updateIssue.mockResolvedValue(undefined);

      await program.parseAsync([
        "node",
        "test",
        "verify",
        "INT-100",
        "--project",
        "docs",
      ]);

      // Should succeed without "multiple projects" error
      expect(mockTracker.updateIssue).toHaveBeenCalled();
    });

    it("uses --project with --list", async () => {
      mockLoadConfig.mockReturnValue(multiProjectConfig());
      mockTracker.listIssues.mockResolvedValue([]);

      await program.parseAsync(["node", "test", "verify", "--list", "--project", "docs"]);

      const output = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No merged-unverified issues");
    });
  });
});
