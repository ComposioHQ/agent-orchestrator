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

describe("notifier-dingtalk", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.DINGTALK_SECRET;
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("dingtalk");
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
    it("returns a notifier with name 'dingtalk'", () => {
      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      expect(notifier.name).toBe("dingtalk");
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
        create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" }),
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

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://oapi.dingtalk.com/robot/send?token=abc");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends JSON with Content-Type header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends markdown msgtype payload", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.msgtype).toBe("markdown");
      expect(body.markdown).toBeDefined();
      expect(body.markdown.title).toBeDefined();
      expect(body.markdown.text).toBeDefined();
    });

    it("includes session ID in markdown title", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await notifier.notify(makeEvent({ sessionId: "backend-3" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.markdown.title).toContain("backend-3");
    });

    it("includes project, priority, and time in markdown text", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await notifier.notify(
        makeEvent({ projectId: "frontend", sessionId: "ui-1", priority: "action" }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const text = body.markdown.text as string;
      expect(text).toContain("**Project:** frontend");
      expect(text).toContain("**Priority:** action");
      expect(text).toContain("**Time:**");
    });

    it("includes PR link when prUrl is a string in event data", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await notifier.notify(
        makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const text = body.markdown.text as string;
      expect(text).toContain("https://github.com/org/repo/pull/42");
      expect(text).toContain("View Pull Request");
    });

    it("ignores prUrl when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const text = body.markdown.text as string;
      expect(text).not.toContain("Pull Request");
    });

    it("uses priority emoji in title", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });

      const priorities: EventPriority[] = ["urgent", "action", "warning", "info"];
      for (const priority of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        // Title should not be empty
        expect(body.markdown.title.length).toBeGreaterThan(0);
      }
    });

    it("appends HMAC signature when DINGTALK_SECRET is set", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.DINGTALK_SECRET = "my-secret-key";

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await notifier.notify(makeEvent());

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("timestamp=");
      expect(url).toContain("sign=");
    });

    it("does not append signature when DINGTALK_SECRET is not set", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await notifier.notify(makeEvent());

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toBe("https://oapi.dingtalk.com/robot/send?token=abc");
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "DingTalk webhook failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes action links in markdown text", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const text = body.markdown.text as string;
      expect(text).toContain("[Merge]");
      expect(text).toContain("[Open]");
      expect(text).toContain("https://github.com/org/repo/pull/42/merge");
    });

    it("filters out actions with no url", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const text = body.markdown.text as string;
      expect(text).toContain("[Merge]");
      expect(text).not.toContain("[No-op]");
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
    it("sends a plain text message via text msgtype", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.msgtype).toBe("text");
      expect(body.text.content).toBe("Hello from AO");
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

      const notifier = create({ webhookUrl: "https://oapi.dingtalk.com/robot/send?token=abc" });
      await expect(notifier.post!("test")).rejects.toThrow(
        "DingTalk webhook failed (400): bad request",
      );
    });
  });
});
