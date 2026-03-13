import { describe, expect, it } from "vitest";
import {
  executeAoAutoReplyCommand,
  parseAoAutoReplyCommand,
  type AoCliRunner,
  type AoAutoReplyMetrics,
} from "./index.js";

function okJson(payload: unknown): ReturnType<AoCliRunner> {
  return Promise.resolve({
    ok: true,
    stdout: JSON.stringify(payload),
    stderr: "",
    exitCode: 0,
  });
}

describe("openclaw command parsing", () => {
  it("parses supported /ao commands", () => {
    expect(parseAoAutoReplyCommand("/ao sessions")).toEqual({ type: "sessions" });
    expect(parseAoAutoReplyCommand("/ao status")).toEqual({ type: "status", sessionId: undefined });
    expect(parseAoAutoReplyCommand("/ao status ao-2")).toEqual({ type: "status", sessionId: "ao-2" });
    expect(parseAoAutoReplyCommand("/ao retry ao-2")).toEqual({ type: "retry", sessionId: "ao-2" });
    expect(parseAoAutoReplyCommand("/ao kill ao-2")).toEqual({ type: "kill", sessionId: "ao-2" });
  });

  it("rejects invalid commands", () => {
    expect(parseAoAutoReplyCommand("hello")).toBeNull();
    expect(parseAoAutoReplyCommand("/aobot sessions")).toBeNull();
    expect(parseAoAutoReplyCommand("/ao retry")).toBeNull();
    expect(parseAoAutoReplyCommand("/ao unknown")).toBeNull();
  });
});

describe("openclaw command execution", () => {
  it("returns deterministic summary for /ao sessions", async () => {
    const runner: AoCliRunner = async () =>
      await okJson([
        { name: "ao-1", status: "working", activity: "active", lastActivity: "1m" },
        { name: "ao-2", status: "stuck", activity: "inactive", lastActivity: "25m" },
      ]);

    const result = await executeAoAutoReplyCommand({ type: "sessions" }, { runner });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("total=2");
    expect(result.message).toContain("active=1");
    expect(result.message).toContain("degraded=1");
    expect(result.message).toContain("ids=ao-1,ao-2");
  });

  it("returns session-specific status for /ao status <id>", async () => {
    const runner: AoCliRunner = async () =>
      await okJson([
        { name: "ao-4", status: "working", activity: "active", lastActivity: "3m" },
      ]);

    const result = await executeAoAutoReplyCommand({ type: "status", sessionId: "ao-4" }, { runner });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("AO status session=ao-4 status=working activity=active last=3m");
  });

  it("runs ao send for /ao retry and tracks failures", async () => {
    const metrics: AoAutoReplyMetrics = { failedSendCommands: 0, failedSpawnCommands: 0 };
    const runner: AoCliRunner = async (args) => {
      expect(args[0]).toBe("send");
      return { ok: false, stdout: "", stderr: "boom", exitCode: 1 };
    };

    const result = await executeAoAutoReplyCommand({ type: "retry", sessionId: "ao-8" }, { runner, metrics });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("ao_send_failed");
    expect(metrics.failedSendCommands).toBe(1);
  });

  it("maps missing ao binary to ao_unavailable", async () => {
    const runner: AoCliRunner = async () => ({
      ok: false,
      stdout: "",
      stderr: "ao: not found",
      exitCode: 1,
      errorCode: "ENOENT",
    });

    const result = await executeAoAutoReplyCommand({ type: "sessions" }, { runner });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("ao_unavailable");
    expect(result.message).toContain("AO CLI unavailable");
  });
});
