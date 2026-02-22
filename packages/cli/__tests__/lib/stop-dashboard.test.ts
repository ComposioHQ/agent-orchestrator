import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock shell exec — must be hoisted before imports
const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

import { stopDashboard } from "../../src/lib/stop-dashboard.js";

describe("stopDashboard", () => {
  beforeEach(() => {
    mockExec.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it('logs "Dashboard stopped" in green when processes are killed', async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: "12345\n" }) // lsof
      .mockResolvedValueOnce({ stdout: "" }); // kill

    await stopDashboard(3000);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Dashboard stopped"));
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("not running"));
  });

  it('logs "Dashboard not running" in yellow when no processes are found', async () => {
    // lsof returns empty (no process on port)
    mockExec.mockResolvedValueOnce({ stdout: "\n" });

    await stopDashboard(3000);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Dashboard not running on port 3000"),
    );
    expect(mockExec).not.toHaveBeenCalledWith("kill", expect.anything());
  });

  it("logs a warning when lsof throws (port not in use)", async () => {
    mockExec.mockRejectedValueOnce(new Error("no match"));

    await stopDashboard(3000);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Could not stop dashboard"));
  });

  it("kills all PIDs returned by lsof", async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: "111\n222\n333\n" }) // lsof
      .mockResolvedValueOnce({ stdout: "" }); // kill

    await stopDashboard(3000);

    expect(mockExec).toHaveBeenCalledWith("kill", ["111", "222", "333"]);
  });
});
