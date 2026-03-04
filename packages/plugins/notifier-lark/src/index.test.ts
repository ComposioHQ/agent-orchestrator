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

describe("notifier-lark", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("lark");
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
    it("returns a notifier with name 'lark'", () => {
      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      expect(notifier.name).toBe("lark");
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
        create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" }),
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

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
      );
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends interactive msg_type payload", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.msg_type).toBe("interactive");
      expect(body.card).toBeDefined();
      expect(body.card.header).toBeDefined();
      expect(body.card.elements).toBeDefined();
    });

    it("includes session ID in card header title", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      await notifier.notify(makeEvent({ sessionId: "backend-3" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.card.header.title.content).toContain("backend-3");
    });

    it("uses correct priority color template", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });

      const priorities: Array<[EventPriority, string]> = [
        ["urgent", "red"],
        ["action", "orange"],
        ["warning", "yellow"],
        ["info", "blue"],
      ];

      for (const [priority, color] of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.card.header.template).toBe(color);
      }
    });

    it("includes project, session, priority, and time in elements", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      await notifier.notify(
        makeEvent({ projectId: "frontend", sessionId: "ui-1", priority: "action" }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bodyStr = JSON.stringify(body.card.elements);
      expect(bodyStr).toContain("**Project:** frontend");
      expect(bodyStr).toContain("**Session:** ui-1");
      expect(bodyStr).toContain("**Priority:** action");
      expect(bodyStr).toContain("**Time:**");
    });

    it("includes PR button when prUrl is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      await notifier.notify(
        makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bodyStr = JSON.stringify(body.card.elements);
      expect(bodyStr).toContain("View Pull Request");
      expect(bodyStr).toContain("https://github.com/org/repo/pull/42");
    });

    it("ignores prUrl when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bodyStr = JSON.stringify(body.card.elements);
      expect(bodyStr).not.toContain("View Pull Request");
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Lark webhook failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes action buttons in card elements", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bodyStr = JSON.stringify(body.card.elements);
      expect(bodyStr).toContain("Merge");
      expect(bodyStr).toContain("Open");
      expect(bodyStr).toContain("https://github.com/org/repo/pull/42/merge");
    });

    it("filters out actions with no url", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const bodyStr = JSON.stringify(body.card.elements);
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
    it("sends a plain text message via text msg_type", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.msg_type).toBe("text");
      expect(body.content.text).toBe("Hello from AO");
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

      const notifier = create({ webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" });
      await expect(notifier.post!("test")).rejects.toThrow(
        "Lark webhook failed (400): bad request",
      );
    });
  });
});
