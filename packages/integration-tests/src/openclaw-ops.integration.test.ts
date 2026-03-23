/**
 * Integration-style tests for OpenClaw phase-1 operational controls.
 *
 * Mocks CLI/network boundaries only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import openClawPlugin, {
  executeAoAutoReplyCommand,
  type AoCliRunner,
} from "@composio/ao-plugin-notifier-openclaw";
import { makeEvent } from "./helpers/event-factory.js";

describe("openclaw phase-1 operations integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.OPENCLAW_HOOKS_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("command success path: /ao status <session>", async () => {
    const runner: AoCliRunner = async () => ({
      ok: true,
      stdout: JSON.stringify([
        { name: "ao-18", status: "working", activity: "active", lastActivity: "2m" },
      ]),
      stderr: "",
      exitCode: 0,
    });

    const result = await executeAoAutoReplyCommand({ type: "status", sessionId: "ao-18" }, { runner });

    expect(result.ok).toBe(true);
    expect(result.message).toBe("AO status session=ao-18 status=working activity=active last=2m");
  });

  it("AO CLI unavailable path returns deterministic failure code", async () => {
    const runner: AoCliRunner = async () => ({
      ok: false,
      stdout: "",
      stderr: "ao not found",
      exitCode: 1,
      errorCode: "ENOENT",
    });

    const result = await executeAoAutoReplyCommand({ type: "sessions" }, { runner });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("ao_unavailable");
    expect(result.message).toBe("AO CLI unavailable");
  });

  it("burst escalation path reduces notification noise via batching", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = openClawPlugin.create({
      token: "tok",
      debounceWindowMs: 1,
      batchTriggerCount: 2,
      batchWindowMs: 75,
      batchSessionKey: "hook:ao:ops",
    });

    await notifier.notify(
      makeEvent({
        type: "reaction.escalated",
        priority: "urgent",
        sessionId: "ao-1",
        message: "Agent stalled",
        data: { reason: "stale" },
      }),
    );
    await notifier.notify(
      makeEvent({
        type: "reaction.escalated",
        priority: "urgent",
        sessionId: "ao-2",
        message: "CI failed",
        data: { reason: "ci_failed" },
      }),
    );
    await notifier.notify(
      makeEvent({
        type: "reaction.escalated",
        priority: "urgent",
        sessionId: "ao-3",
        message: "Send failed",
        data: { reason: "send_failed" },
      }),
    );

    // Only first event sent immediately; subsequent burst events are batched.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const summaryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(summaryBody.sessionKey).toBe("hook:ao:ops");
    expect(summaryBody.message).toContain("batched_escalations");
  });
});
