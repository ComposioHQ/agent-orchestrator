import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorEvent } from "@composio/ao-core";
import { manifest, create } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.spawned",
    priority: "info",
    sessionId: "app-1",
    projectId: "proj",
    timestamp: new Date("2026-02-25T00:00:00Z"),
    message: "hello",
    data: {},
    ...overrides,
  };
}

describe("notifier-discord", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("has manifest metadata", () => {
    expect(manifest.name).toBe("discord");
    expect(manifest.slot).toBe("notifier");
  });

  it("posts events to webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "ok" });
    vi.stubGlobal("fetch", fetchMock);

    const notifier = create({ webhookUrl: "https://discord.com/api/webhooks/1/abc" });
    await notifier.notify(makeEvent());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain("discord.com/api/webhooks");
  });
});
