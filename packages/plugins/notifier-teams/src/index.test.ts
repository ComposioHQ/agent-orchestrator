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

describe("notifier-teams", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("teams");
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
    it("returns a notifier with name 'teams'", () => {
      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      expect(notifier.name).toBe("teams");
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

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://outlook.office.com/webhook/test");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends JSON with Content-Type header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends Adaptive Card payload structure", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("message");
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0].contentType).toBe(
        "application/vnd.microsoft.card.adaptive",
      );
      const card = body.attachments[0].content;
      expect(card.type).toBe("AdaptiveCard");
      expect(card.version).toBe("1.4");
      expect(card.$schema).toBe("http://adaptivecards.io/schemas/adaptive-card.json");
    });

    it("includes title TextBlock with session ID and priority emoji", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await notifier.notify(makeEvent({ sessionId: "backend-3", priority: "urgent" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const card = body.attachments[0].content;
      const titleBlock = card.body[0];
      expect(titleBlock.type).toBe("TextBlock");
      expect(titleBlock.size).toBe("Large");
      expect(titleBlock.weight).toBe("Bolder");
      expect(titleBlock.text).toContain("backend-3");
      expect(titleBlock.color).toBe("attention");
    });

    it("uses correct Adaptive Card color for each priority", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });

      const priorities: Array<[EventPriority, string]> = [
        ["urgent", "attention"],
        ["action", "warning"],
        ["warning", "warning"],
        ["info", "default"],
      ];

      for (const [priority, color] of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const titleBlock = body.attachments[0].content.body[0];
        expect(titleBlock.color).toBe(color);
      }
    });

    it("includes message TextBlock", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await notifier.notify(makeEvent({ message: "CI is green" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const card = body.attachments[0].content;
      const messageBlock = card.body[1];
      expect(messageBlock.type).toBe("TextBlock");
      expect(messageBlock.text).toBe("CI is green");
      expect(messageBlock.wrap).toBe(true);
    });

    it("includes FactSet with project, session, priority, and time", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await notifier.notify(
        makeEvent({ projectId: "frontend", sessionId: "ui-1", priority: "action" }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const card = body.attachments[0].content;
      const factSet = card.body[2];
      expect(factSet.type).toBe("FactSet");
      expect(factSet.facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Project", value: "frontend" }),
          expect.objectContaining({ title: "Session", value: "ui-1" }),
          expect.objectContaining({ title: "Priority", value: "action" }),
        ]),
      );
    });

    it("includes PR link when prUrl is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const card = body.attachments[0].content;
      const prBlock = card.body.find(
        (b: Record<string, unknown>) =>
          b.type === "TextBlock" &&
          typeof b.text === "string" &&
          (b.text as string).includes("View Pull Request"),
      );
      expect(prBlock).toBeDefined();
      expect(prBlock.text).toContain("https://github.com/org/repo/pull/42");
    });

    it("ignores prUrl when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const card = body.attachments[0].content;
      const prBlock = card.body.find(
        (b: Record<string, unknown>) =>
          b.type === "TextBlock" &&
          typeof b.text === "string" &&
          (b.text as string).includes("View Pull Request"),
      );
      expect(prBlock).toBeUndefined();
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Teams webhook failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes Action.OpenUrl actions for URL-based actions", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const card = body.attachments[0].content;
      expect(card.actions).toHaveLength(2);
      expect(card.actions[0].type).toBe("Action.OpenUrl");
      expect(card.actions[0].title).toBe("Merge");
      expect(card.actions[0].url).toBe("https://github.com/org/repo/pull/42/merge");
    });

    it("filters out actions without URL", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Callback", callbackEndpoint: "/api/sessions/app-1/kill" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const card = body.attachments[0].content;
      expect(card.actions).toHaveLength(1);
      expect(card.actions[0].title).toBe("Merge");
    });

    it("omits actions field when no valid actions", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      const actions: NotifyAction[] = [{ label: "No-op" }];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const card = body.attachments[0].content;
      expect(card.actions).toBeUndefined();
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
    it("sends a plain text message as Adaptive Card TextBlock", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe("message");
      const card = body.attachments[0].content;
      expect(card.body[0].type).toBe("TextBlock");
      expect(card.body[0].text).toBe("Hello from AO");
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
        status: 403,
        text: () => Promise.resolve("forbidden"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://outlook.office.com/webhook/test" });
      await expect(notifier.post!("test")).rejects.toThrow(
        "Teams webhook failed (403): forbidden",
      );
    });
  });
});
