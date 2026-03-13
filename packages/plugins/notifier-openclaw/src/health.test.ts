import { describe, expect, it, vi } from "vitest";
import {
  AoHealthPollingService,
  collectAoHealthSummary,
  type AoCliRunner,
  type AoAutoReplyMetrics,
} from "./index.js";

describe("health polling", () => {
  it("computes active/degraded/dead/stale from ao status --json", async () => {
    const runner: AoCliRunner = async () => ({
      ok: true,
      stdout: JSON.stringify([
        { name: "ao-1", status: "working", activity: "active", lastActivity: "2m" },
        { name: "ao-2", status: "stuck", activity: "inactive", lastActivity: "40m" },
        { name: "ao-3", status: "dead", activity: "inactive", lastActivity: "1h" },
      ]),
      stderr: "",
      exitCode: 0,
    });
    const metrics: AoAutoReplyMetrics = { failedSendCommands: 2, failedSpawnCommands: 1 };

    const summary = await collectAoHealthSummary({ runner, staleAfterMinutes: 30, metrics });

    expect(summary.source).toBe("ao-cli");
    expect(summary.total).toBe(3);
    expect(summary.active).toBe(1);
    expect(summary.degraded).toBe(1);
    expect(summary.dead).toBe(1);
    expect(summary.stale).toBe(2);
    expect(summary.staleSessions).toEqual(["ao-2", "ao-3"]);
    expect(summary.failedSendCommands).toBe(2);
    expect(summary.failedSpawnCommands).toBe(1);
  });

  it("returns ao_unavailable when binary is missing", async () => {
    const runner: AoCliRunner = async () => ({
      ok: false,
      stdout: "",
      stderr: "not found",
      exitCode: 1,
      errorCode: "ENOENT",
    });

    const summary = await collectAoHealthSummary({ runner });

    expect(summary.source).toBe("error");
    expect(summary.errorCode).toBe("ao_unavailable");
    expect(summary.total).toBe(0);
  });

  it("publishes periodic summaries", async () => {
    vi.useFakeTimers();

    const runner: AoCliRunner = async () => ({
      ok: true,
      stdout: JSON.stringify([{ name: "ao-1", status: "working", activity: "active", lastActivity: "1m" }]),
      stderr: "",
      exitCode: 0,
    });
    const onSummary = vi.fn();

    const service = new AoHealthPollingService({ runner, pollIntervalMs: 1000, onSummary });
    service.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onSummary).toHaveBeenCalledTimes(3);
    service.stop();
    vi.useRealTimers();
  });

  it("catches onSummary errors and keeps polling", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const runner: AoCliRunner = async () => ({
      ok: true,
      stdout: JSON.stringify([{ name: "ao-1", status: "working", activity: "active", lastActivity: "1m" }]),
      stderr: "",
      exitCode: 0,
    });
    const onSummary = vi.fn().mockRejectedValue(new Error("sink failed"));

    const service = new AoHealthPollingService({ runner, pollIntervalMs: 1000, onSummary });
    service.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onSummary).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      "[notifier-openclaw] AO health polling failed:",
      expect.any(Error),
    );

    service.stop();
    vi.useRealTimers();
  });
});
