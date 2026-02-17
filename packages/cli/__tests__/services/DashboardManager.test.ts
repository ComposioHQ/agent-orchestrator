import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

// Mock fs
const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

// Mock web-dir
const { mockFindWebDir } = vi.hoisted(() => ({
  mockFindWebDir: vi.fn(),
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  findWebDir: mockFindWebDir,
}));

// Mock shell exec
const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

import { DashboardManager } from "../../src/services/DashboardManager.js";
import type { ServicePorts } from "../../src/services/PortManager.js";

describe("DashboardManager", () => {
  let dm: DashboardManager;
  let mockChild: {
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };

  const testPorts: ServicePorts = {
    dashboard: 4000,
    terminalWs: 3001,
    directTerminalWs: 3003,
  };

  beforeEach(() => {
    dm = new DashboardManager();
    mockChild = {
      on: vi.fn(),
      once: vi.fn(),
      kill: vi.fn(),
    };
    mockSpawn.mockReset().mockReturnValue(mockChild);
    mockExistsSync.mockReset();
    mockFindWebDir.mockReset();
    mockExec.mockReset();
  });

  describe("start", () => {
    it("should spawn pnpm dev with correct env vars", () => {
      mockFindWebDir.mockReturnValue("/path/to/web");
      mockExistsSync.mockReturnValue(true);

      dm.start({
        ports: testPorts,
        configPath: "/path/to/config.yaml",
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        "pnpm",
        ["run", "dev"],
        expect.objectContaining({
          cwd: "/path/to/web",
          stdio: "inherit",
        }),
      );

      const env = mockSpawn.mock.calls[0][2].env;
      expect(env["AO_CONFIG_PATH"]).toBe("/path/to/config.yaml");
      expect(env["PORT"]).toBe("4000");
      expect(env["TERMINAL_PORT"]).toBe("3001");
      expect(env["DIRECT_TERMINAL_PORT"]).toBe("3003");
    });

    it("should not set AO_CONFIG_PATH when configPath is null", () => {
      mockFindWebDir.mockReturnValue("/path/to/web");
      mockExistsSync.mockReturnValue(true);

      dm.start({
        ports: testPorts,
        configPath: null,
      });

      const env = mockSpawn.mock.calls[0][2].env;
      expect(env["AO_CONFIG_PATH"]).toBeUndefined();
    });

    it("should throw when web package not found", () => {
      mockFindWebDir.mockReturnValue("/nonexistent");
      mockExistsSync.mockReturnValue(false);

      expect(() =>
        dm.start({
          ports: testPorts,
          configPath: null,
        }),
      ).toThrow("Could not find @composio/ao-web package");
    });

    it("should return the child process", () => {
      mockFindWebDir.mockReturnValue("/path/to/web");
      mockExistsSync.mockReturnValue(true);

      const child = dm.start({
        ports: testPorts,
        configPath: null,
      });

      expect(child).toBe(mockChild);
    });

    it("should register error handler on child process", () => {
      mockFindWebDir.mockReturnValue("/path/to/web");
      mockExistsSync.mockReturnValue(true);

      dm.start({
        ports: testPorts,
        configPath: null,
      });

      expect(mockChild.on).toHaveBeenCalledWith("error", expect.any(Function));
    });
  });

  describe("stop", () => {
    it("should kill processes on all service ports", async () => {
      mockExec.mockResolvedValue({ stdout: "12345\n" });

      await dm.stop(testPorts);

      // Should check all three ports
      expect(mockExec).toHaveBeenCalledWith("lsof", ["-ti", ":4000"]);
      expect(mockExec).toHaveBeenCalledWith("lsof", ["-ti", ":3001"]);
      expect(mockExec).toHaveBeenCalledWith("lsof", ["-ti", ":3003"]);

      // Should kill collected PIDs
      expect(mockExec).toHaveBeenCalledWith("kill", expect.arrayContaining(["12345"]));
    });

    it("should deduplicate PIDs across ports", async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: "12345\n" }) // port 4000
        .mockResolvedValueOnce({ stdout: "12345\n" }) // port 3001 (same PID)
        .mockResolvedValueOnce({ stdout: "67890\n" }) // port 3003
        .mockResolvedValue({ stdout: "" }); // kill call

      await dm.stop(testPorts);

      // Last call should be kill with deduplicated PIDs
      const killCall = mockExec.mock.calls.find(
        (call: unknown[]) => call[0] === "kill",
      );
      expect(killCall).toBeDefined();
      expect(killCall![1]).toHaveLength(2); // Only 2 unique PIDs
      expect(killCall![1]).toContain("12345");
      expect(killCall![1]).toContain("67890");
    });

    it("should handle no processes running", async () => {
      mockExec.mockRejectedValue(new Error("no match"));

      // Should not throw
      await dm.stop(testPorts);
    });
  });

  describe("isRunning", () => {
    it("should return true when process on port", async () => {
      mockExec.mockResolvedValue({ stdout: "12345\n" });

      const running = await dm.isRunning(4000);
      expect(running).toBe(true);
    });

    it("should return false when no process on port", async () => {
      mockExec.mockRejectedValue(new Error("no match"));

      const running = await dm.isRunning(4000);
      expect(running).toBe(false);
    });
  });
});
