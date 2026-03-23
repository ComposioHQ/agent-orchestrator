import { describe, expect, it, vi } from "vitest";
import { EscalationNoiseController } from "./noise-control.js";
import type { OrchestratorEvent } from "@composio/ao-core";

function makeEvent(sessionId: string, reason: string): OrchestratorEvent {
  return {
    id: `evt-${sessionId}`,
    type: "reaction.escalated",
    priority: "urgent",
    sessionId,
    projectId: "ao",
    timestamp: new Date("2026-03-10T12:00:00Z"),
    message: "Escalated",
    data: { reason },
  };
}

describe("EscalationNoiseController", () => {
  it("catches batch callback failures", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const onBatchReady = vi.fn().mockRejectedValue(new Error("batch sink failed"));
    const controller = new EscalationNoiseController({
      batchTriggerCount: 2,
      batchWindowMs: 20,
      debounceWindowMs: 1,
      onBatchReady,
    });

    expect(controller.evaluateEvent(makeEvent("ao-1", "r1"))).toBe("send");
    expect(controller.evaluateEvent(makeEvent("ao-2", "r2"))).toBe("batched");
    expect(controller.evaluateEvent(makeEvent("ao-3", "r3"))).toBe("batched");

    await vi.advanceTimersByTimeAsync(25);

    expect(onBatchReady).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      "[notifier-openclaw] Failed to flush escalation batch:",
      expect.any(Error),
    );

    vi.useRealTimers();
  });
});
