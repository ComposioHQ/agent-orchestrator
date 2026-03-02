import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorEvent, NotifyAction, EventPriority } from "@composio/ao-core";
import pluginDefault, { manifest, create } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.spawned",
    priority: "info",
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-06-15T12:00:00Z"),
    message: "Session app-1 spawned successfully",
    data: {},
    ...overrides,
  };
}

function mockFetchOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve("ok"),
  });
}

describe("notifier-pagerduty", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PAGERDUTY_ROUTING_KEY;
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("pagerduty");
      expect(manifest.slot).toBe("notifier");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("default export", () => {
    it("is a valid PluginModule", () => {
      expect(pluginDefault.manifest).toBe(manifest);
      expect(typeof pluginDefault.create).toBe("function");
    });
  });

  describe("create", () => {
    it("returns a notifier with name 'pagerduty'", () => {
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";
      const notifier = create();
      expect(notifier.name).toBe("pagerduty");
    });

    it("warns when PAGERDUTY_ROUTING_KEY is missing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing PAGERDUTY_ROUTING_KEY"),
      );
    });
  });

  describe("notify", () => {
    it("does nothing when no routing key", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does nothing for info priority events", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "info" }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does nothing for warning priority events", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "warning" }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("triggers for urgent priority events", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("triggers for action priority events", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "action" }));
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("POSTs to the PagerDuty Events API v2 endpoint", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      expect(fetchMock.mock.calls[0][0]).toBe("https://events.pagerduty.com/v2/enqueue");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends correct payload structure with routing_key", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.routing_key).toBe("test-key");
      expect(body.event_action).toBe("trigger");
      expect(body.payload).toBeDefined();
    });

    it("maps priority to correct PagerDuty severity", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();

      const priorities: Array<[EventPriority, string]> = [
        ["urgent", "critical"],
        ["action", "error"],
      ];

      for (const [priority, severity] of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.payload.severity).toBe(severity);
      }
    });

    it("includes session and project in payload source", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(
        makeEvent({ projectId: "frontend", sessionId: "ui-1", priority: "urgent" }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.source).toBe("ao/frontend/ui-1");
      expect(body.payload.component).toBe("frontend");
      expect(body.payload.group).toBe("ui-1");
    });

    it("includes timestamp in payload", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.timestamp).toBe("2025-06-15T12:00:00.000Z");
    });

    it("includes PR link when prUrl is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(
        makeEvent({
          priority: "urgent",
          data: { prUrl: "https://github.com/org/repo/pull/42" },
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            href: "https://github.com/org/repo/pull/42",
            text: "Pull Request",
          }),
        ]),
      );
    });

    it("does not include links when prUrl is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent", data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.links).toBeUndefined();
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await expect(notifier.notify(makeEvent({ priority: "urgent" }))).rejects.toThrow(
        "PagerDuty API failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes action links in PagerDuty links array", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent({ priority: "urgent" }), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ href: "https://github.com/org/repo/pull/42/merge", text: "Merge" }),
          expect.objectContaining({ href: "https://github.com/org/repo/pull/42", text: "Open" }),
        ]),
      );
    });

    it("filters out actions with no url", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent({ priority: "urgent" }), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const linkTexts = (body.links as Array<{ text: string }>).map((l) => l.text);
      expect(linkTexts).toContain("Merge");
      expect(linkTexts).not.toContain("No-op");
    });

    it("does nothing for low priority events", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.notifyWithActions!(makeEvent({ priority: "info" }), []);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does nothing when no routing key", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await notifier.notifyWithActions!(makeEvent({ priority: "urgent" }), []);
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("post", () => {
    it("sends a minimal trigger event with message as summary", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.routing_key).toBe("test-key");
      expect(body.event_action).toBe("trigger");
      expect(body.payload.summary).toBe("Hello from AO");
      expect(body.payload.severity).toBe("info");
      expect(result).toBeNull();
    });

    it("uses context projectId in source when provided", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.post!("test", { projectId: "my-proj" });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.source).toBe("ao/my-proj");
    });

    it("uses 'unknown' in source when no context", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await notifier.post!("test");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.source).toBe("ao/unknown");
    });

    it("returns null when no routing key", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const notifier = create();
      const result = await notifier.post!("test");
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("bad request"),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PAGERDUTY_ROUTING_KEY = "test-key";

      const notifier = create();
      await expect(notifier.post!("test")).rejects.toThrow(
        "PagerDuty API failed (400): bad request",
      );
    });
  });
});
