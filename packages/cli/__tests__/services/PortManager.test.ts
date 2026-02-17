import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockIsPortAvailable } = vi.hoisted(() => ({
  mockIsPortAvailable: vi.fn(),
}));

vi.mock("../../src/lib/port.js", () => ({
  isPortAvailable: mockIsPortAvailable,
}));

import { PortManager } from "../../src/services/PortManager.js";

describe("PortManager", () => {
  let pm: PortManager;

  beforeEach(() => {
    pm = new PortManager();
    mockIsPortAvailable.mockReset();
  });

  describe("findAvailable", () => {
    it("should return preferred port when available", async () => {
      mockIsPortAvailable.mockResolvedValue(true);

      const port = await pm.findAvailable(4000);
      expect(port).toBe(4000);
      expect(mockIsPortAvailable).toHaveBeenCalledWith(4000);
    });

    it("should skip to next port when preferred is taken", async () => {
      mockIsPortAvailable
        .mockResolvedValueOnce(false) // 4000 taken
        .mockResolvedValueOnce(true); // 4001 available

      const port = await pm.findAvailable(4000);
      expect(port).toBe(4001);
    });

    it("should throw when no port found after max attempts", async () => {
      mockIsPortAvailable.mockResolvedValue(false);

      await expect(pm.findAvailable(4000, 3)).rejects.toThrow(
        "Could not find available port near 4000 after 3 attempts",
      );
    });

    it("should skip already-allocated ports", async () => {
      mockIsPortAvailable.mockResolvedValue(true);

      // Allocate 4000
      const first = await pm.findAvailable(4000);
      expect(first).toBe(4000);

      // Next call should skip 4000
      const second = await pm.findAvailable(4000);
      expect(second).toBe(4001);
    });
  });

  describe("allocateServicePorts", () => {
    it("should allocate all three service ports", async () => {
      mockIsPortAvailable.mockResolvedValue(true);

      const ports = await pm.allocateServicePorts(4000);

      expect(ports.dashboard).toBe(4000);
      expect(ports.terminalWs).toBe(3001);
      expect(ports.directTerminalWs).toBe(3003);
    });

    it("should handle port conflicts", async () => {
      mockIsPortAvailable.mockImplementation(async (port: number) => {
        // 4000 and 3001 are taken
        return port !== 4000 && port !== 3001;
      });

      const ports = await pm.allocateServicePorts(4000);

      expect(ports.dashboard).toBe(4001);
      expect(ports.terminalWs).toBe(3002);
      expect(ports.directTerminalWs).toBe(3003);
    });

    it("should not double-allocate ports", async () => {
      mockIsPortAvailable.mockResolvedValue(true);

      const ports = await pm.allocateServicePorts(3001);

      // Dashboard wants 3001, gets it
      expect(ports.dashboard).toBe(3001);
      // Terminal WS also wants 3001 but it's allocated, gets 3002
      expect(ports.terminalWs).toBe(3002);
      // Direct terminal WS wants 3003, gets it
      expect(ports.directTerminalWs).toBe(3003);
    });
  });

  describe("release", () => {
    it("should release a port for reuse", async () => {
      mockIsPortAvailable.mockResolvedValue(true);

      const port = await pm.findAvailable(4000);
      expect(port).toBe(4000);

      // Without release, 4000 is skipped
      const port2 = await pm.findAvailable(4000);
      expect(port2).toBe(4001);

      // Release 4000
      pm.release(4000);

      const port3 = await pm.findAvailable(4000);
      expect(port3).toBe(4000); // Available again
    });
  });

  describe("releaseAll", () => {
    it("should release all allocated ports", async () => {
      mockIsPortAvailable.mockResolvedValue(true);

      await pm.allocateServicePorts(4000);
      expect(pm.getAllocatedPorts().size).toBe(3);

      pm.releaseAll();
      expect(pm.getAllocatedPorts().size).toBe(0);
    });
  });

  describe("getAllocatedPorts", () => {
    it("should track allocated ports", async () => {
      mockIsPortAvailable.mockResolvedValue(true);

      await pm.findAvailable(5000);
      await pm.findAvailable(6000);

      const allocated = pm.getAllocatedPorts();
      expect(allocated.has(5000)).toBe(true);
      expect(allocated.has(6000)).toBe(true);
      expect(allocated.size).toBe(2);
    });
  });
});
