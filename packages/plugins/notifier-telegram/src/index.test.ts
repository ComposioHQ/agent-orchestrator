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

describe("notifier-telegram", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("telegram");
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
    it("returns a notifier with name 'telegram'", () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const notifier = create({ chatId: "12345" });
      expect(notifier.name).toBe("telegram");
    });

    it("warns when TELEGRAM_BOT_TOKEN is missing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create({ chatId: "12345" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing TELEGRAM_BOT_TOKEN or chatId"),
      );
    });

    it("warns when chatId is missing", () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing TELEGRAM_BOT_TOKEN or chatId"),
      );
    });

    it("warns when both token and chatId are missing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing TELEGRAM_BOT_TOKEN or chatId"),
      );
    });
  });

  describe("notify", () => {
    it("does nothing when token is missing", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create({ chatId: "12345" });
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does nothing when chatId is missing", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("POSTs to the Telegram sendMessage endpoint", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token-123";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.telegram.org/bottest-token-123/sendMessage",
      );
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends JSON with Content-Type header", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends correct chat_id and parse_mode", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "67890" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.chat_id).toBe("67890");
      expect(body.parse_mode).toBe("MarkdownV2");
    });

    it("includes event type and session ID in message text", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      await notifier.notify(makeEvent({ sessionId: "backend-3", type: "ci.failed" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toContain("ci\\.failed");
      expect(body.text).toContain("backend\\-3");
    });

    it("includes project and priority in message text", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      await notifier.notify(makeEvent({ projectId: "frontend", priority: "action" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toContain("*Project:*");
      expect(body.text).toContain("frontend");
      expect(body.text).toContain("*Priority:*");
      expect(body.text).toContain("action");
    });

    it("includes PR link when prUrl is a string", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toContain("[View Pull Request]");
      expect(body.text).toContain("https://github.com/org/repo/pull/42");
    });

    it("does not include reply_markup for simple notify", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.reply_markup).toBeUndefined();
    });

    it("throws on non-ok response", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Telegram API failed (401): Unauthorized",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes inline keyboard for URL-based actions", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.reply_markup).toBeDefined();
      expect(body.reply_markup.inline_keyboard).toHaveLength(2);
      expect(body.reply_markup.inline_keyboard[0][0].text).toBe("Merge");
      expect(body.reply_markup.inline_keyboard[0][0].url).toBe(
        "https://github.com/org/repo/pull/42/merge",
      );
    });

    it("includes callback_data for callback-based actions", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      const actions: NotifyAction[] = [
        { label: "Kill Session", callbackEndpoint: "/api/sessions/app-1/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.reply_markup.inline_keyboard[0][0].text).toBe("Kill Session");
      expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe(
        "/api/sessions/app-1/kill",
      );
    });

    it("filters out actions with no url or callback", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.reply_markup.inline_keyboard).toHaveLength(1);
      expect(body.reply_markup.inline_keyboard[0][0].text).toBe("Merge");
    });

    it("omits reply_markup when no valid actions exist", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      const actions: NotifyAction[] = [{ label: "No-op" }];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.reply_markup).toBeUndefined();
    });

    it("does nothing when config is missing", async () => {
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
    it("sends escaped plain text message", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toBe("Hello from AO");
      expect(body.chat_id).toBe("12345");
      expect(result).toBeNull();
    });

    it("returns null when config is missing", async () => {
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
      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad Request"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ chatId: "12345" });
      await expect(notifier.post!("test")).rejects.toThrow(
        "Telegram API failed (400): Bad Request",
      );
    });
  });
});
