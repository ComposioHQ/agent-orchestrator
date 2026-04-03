import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LifecycleManager, OrchestratorConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockLifecycleStart, mockLifecycleStop, mockGetLifecycleManager } = vi.hoisted(() => {
  const mockLifecycleStart = vi.fn();
  const mockLifecycleStop = vi.fn();
  const mockInstance: LifecycleManager = { start: mockLifecycleStart, stop: mockLifecycleStop } as unknown as LifecycleManager;
  const mockGetLifecycleManager = vi.fn().mockResolvedValue(mockInstance);
  return { mockLifecycleStart, mockLifecycleStop, mockGetLifecycleManager, mockInstance };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getLifecycleManager: mockGetLifecycleManager,
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

const {
  ensureLifecycleWorker,
  stopLifecycleWorker,
  getLifecycleWorkerStatus,
  clearActiveManagers,
} = await import("../../src/lib/lifecycle-service.js");

const config = {} as OrchestratorConfig;

describe("lifecycle-service (in-process)", () => {
  beforeEach(() => {
    clearActiveManagers();
    mockLifecycleStart.mockReset();
    mockLifecycleStop.mockReset();
    mockGetLifecycleManager.mockClear();
  });

  describe("ensureLifecycleWorker", () => {
    it("creates and starts a lifecycle manager on first call", async () => {
      const status = await ensureLifecycleWorker(config, "my-project");

      expect(mockGetLifecycleManager).toHaveBeenCalledWith(config, "my-project");
      expect(mockLifecycleStart).toHaveBeenCalledWith(30_000);
      expect(status.running).toBe(true);
      expect(status.started).toBe(true);
      expect(status.pid).toBe(process.pid);
    });

    it("returns running=true, started=false if already active", async () => {
      // First call starts it
      await ensureLifecycleWorker(config, "my-project");
      mockGetLifecycleManager.mockClear();
      mockLifecycleStart.mockClear();

      // Second call should not recreate
      const status = await ensureLifecycleWorker(config, "my-project");

      expect(mockGetLifecycleManager).not.toHaveBeenCalled();
      expect(mockLifecycleStart).not.toHaveBeenCalled();
      expect(status.running).toBe(true);
      expect(status.started).toBe(false);
      expect(status.pid).toBe(process.pid);
    });

    it("manages separate managers for different project IDs", async () => {
      await ensureLifecycleWorker(config, "project-a");
      await ensureLifecycleWorker(config, "project-b");

      expect(mockGetLifecycleManager).toHaveBeenCalledTimes(2);
      expect(mockGetLifecycleManager).toHaveBeenCalledWith(config, "project-a");
      expect(mockGetLifecycleManager).toHaveBeenCalledWith(config, "project-b");
    });
  });

  describe("stopLifecycleWorker", () => {
    it("stops and removes an active manager", async () => {
      await ensureLifecycleWorker(config, "my-project");

      const stopped = await stopLifecycleWorker(config, "my-project");

      expect(stopped).toBe(true);
      expect(mockLifecycleStop).toHaveBeenCalled();

      // Should no longer be tracked
      const status = getLifecycleWorkerStatus(config, "my-project");
      expect(status.running).toBe(false);
    });

    it("returns false if no manager is running for the project", async () => {
      const stopped = await stopLifecycleWorker(config, "nonexistent");
      expect(stopped).toBe(false);
    });
  });

  describe("getLifecycleWorkerStatus", () => {
    it("returns running=false for unknown project", () => {
      const status = getLifecycleWorkerStatus(config, "unknown");
      expect(status.running).toBe(false);
      expect(status.started).toBe(false);
      expect(status.pid).toBeNull();
    });

    it("returns running=true with pid for active project", async () => {
      await ensureLifecycleWorker(config, "active-project");

      const status = getLifecycleWorkerStatus(config, "active-project");
      expect(status.running).toBe(true);
      expect(status.pid).toBe(process.pid);
    });
  });
});
