import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorEvent, NotifyAction } from "@composio/ao-core";
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

describe("notifier-webex", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.WEBEX_BOT_TOKEN;
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("webex");
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
    it("returns a notifier with name 'webex'", () => {
      process.env.WEBEX_BOT_TOKEN = "bot-token";
      const notifier = create({ roomId: "room-123" });
      expect(notifier.name).toBe("webex");
    });

    it("warns when WEBEX_BOT_TOKEN or roomId is missing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing WEBEX_BOT_TOKEN or roomId"),
      );
    });

    it("warns when only token is set but roomId is missing", () => {
      process.env.WEBEX_BOT_TOKEN = "bot-token";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing WEBEX_BOT_TOKEN or roomId"),
      );
    });
  });

  describe("notify", () => {
    it("does nothing when credentials missing", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("POSTs to the Webex Messages API endpoint", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://webexapis.com/v1/messages");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends JSON with Content-Type and Authorization headers", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.headers.Authorization).toBe("Bearer bot-token");
    });

    it("sends payload with roomId and markdown", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.roomId).toBe("room-123");
      expect(body.markdown).toBeDefined();
    });

    it("includes session ID in markdown", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await notifier.notify(makeEvent({ sessionId: "backend-3" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.markdown).toContain("backend-3");
    });

    it("includes project, priority, and time in markdown", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await notifier.notify(
        makeEvent({ projectId: "frontend", priority: "action" }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const md = body.markdown as string;
      expect(md).toContain("**Project:** frontend");
      expect(md).toContain("**Priority:** action");
      expect(md).toContain("**Time:**");
    });

    it("includes PR link when prUrl is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await notifier.notify(
        makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.markdown).toContain("[View Pull Request](https://github.com/org/repo/pull/42)");
    });

    it("ignores prUrl when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.markdown).not.toContain("View Pull Request");
    });

    it("includes CI status when ciStatus is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await notifier.notify(makeEvent({ data: { ciStatus: "passing" } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.markdown).toContain("**CI Status:** passing");
    });

    it("ignores ciStatus when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await notifier.notify(makeEvent({ data: { ciStatus: 42 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.markdown).not.toContain("CI Status");
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Webex API failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes action links in markdown", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const md = body.markdown as string;
      expect(md).toContain("[Merge]");
      expect(md).toContain("[Open]");
      expect(md).toContain("https://github.com/org/repo/pull/42/merge");
    });

    it("filters out actions with no url", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const md = body.markdown as string;
      expect(md).toContain("[Merge]");
      expect(md).not.toContain("[No-op]");
    });

    it("does nothing when credentials missing", async () => {
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
    it("sends a plain text message as markdown", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.markdown).toBe("Hello from AO");
      expect(body.roomId).toBe("room-123");
      expect(result).toBeNull();
    });

    it("returns null when credentials missing", async () => {
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
      process.env.WEBEX_BOT_TOKEN = "bot-token";

      const notifier = create({ roomId: "room-123" });
      await expect(notifier.post!("test")).rejects.toThrow(
        "Webex API failed (400): bad request",
      );
    });
  });
});
