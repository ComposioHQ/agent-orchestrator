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

describe("notifier-google-chat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("google-chat");
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
    it("returns a notifier with name 'google-chat'", () => {
      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      expect(notifier.name).toBe("google-chat");
    });

    it("warns when no webhookUrl configured", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("No webhookUrl configured"),
      );
    });

    it("throws on invalid URL scheme", () => {
      expect(() => create({ webhookUrl: "file:///etc/passwd" })).toThrow("must be http(s)");
    });

    it("does not throw for valid https URL", () => {
      expect(() =>
        create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" }),
      ).not.toThrow();
    });
  });

  describe("notify", () => {
    it("does nothing when no webhookUrl", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("POSTs to the webhook URL", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://chat.googleapis.com/v1/spaces/xxx/messages",
      );
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends JSON with Content-Type header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends payload with cardsV2 array", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.cardsV2).toBeDefined();
      expect(body.cardsV2).toHaveLength(1);
    });

    it("includes card header with session ID and event type", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await notifier.notify(makeEvent({ sessionId: "backend-3" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const card = body.cardsV2[0].card;
      expect(card.header.title).toContain("backend-3");
      expect(card.header.title).toContain("session.spawned");
    });

    it("includes priority and timestamp in header subtitle", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await notifier.notify(makeEvent({ priority: "warning" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const subtitle = body.cardsV2[0].card.header.subtitle as string;
      expect(subtitle).toContain("warning");
      expect(subtitle).toContain("2025-06-15T12:00:00.000Z");
    });

    it("includes cardId using event id", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await notifier.notify(makeEvent({ id: "evt-42" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.cardsV2[0].cardId).toBe("ao-evt-42");
    });

    it("includes project and session in column widgets", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await notifier.notify(makeEvent({ projectId: "frontend", sessionId: "ui-1" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const widgets = body.cardsV2[0].card.sections[0].widgets;
      const bodyStr = JSON.stringify(widgets);
      expect(bodyStr).toContain("frontend");
      expect(bodyStr).toContain("ui-1");
    });

    it("includes PR button when prUrl is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await notifier.notify(
        makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const widgets = body.cardsV2[0].card.sections[0].widgets;
      const bodyStr = JSON.stringify(widgets);
      expect(bodyStr).toContain("View Pull Request");
      expect(bodyStr).toContain("https://github.com/org/repo/pull/42");
    });

    it("ignores prUrl when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toContain("View Pull Request");
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Google Chat webhook failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes action buttons in card widgets", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).toContain("Merge");
      expect(bodyStr).toContain("Open");
      expect(bodyStr).toContain("https://github.com/org/repo/pull/42/merge");
    });

    it("filters out actions with no url", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bodyStr = JSON.stringify(body);
      expect(bodyStr).toContain("Merge");
      expect(bodyStr).not.toContain("No-op");
    });

    it("does nothing when no webhookUrl", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await notifier.notifyWithActions!(makeEvent(), []);
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("post", () => {
    it("sends a plain text message via text field", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toBe("Hello from AO");
      expect(result).toBeNull();
    });

    it("returns null when no webhookUrl", async () => {
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

      const notifier = create({ webhookUrl: "https://chat.googleapis.com/v1/spaces/xxx/messages" });
      await expect(notifier.post!("test")).rejects.toThrow(
        "Google Chat webhook failed (400): bad request",
      );
    });
  });
});
