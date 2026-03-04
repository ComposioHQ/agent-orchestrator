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

describe("notifier-pushover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PUSHOVER_APP_TOKEN;
    delete process.env.PUSHOVER_USER_KEY;
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("pushover");
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
    it("returns a notifier with name 'pushover'", () => {
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";
      const notifier = create();
      expect(notifier.name).toBe("pushover");
    });

    it("warns when PUSHOVER_APP_TOKEN or PUSHOVER_USER_KEY is missing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing PUSHOVER_APP_TOKEN or PUSHOVER_USER_KEY"),
      );
    });

    it("warns when only PUSHOVER_APP_TOKEN is set", () => {
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing PUSHOVER_APP_TOKEN or PUSHOVER_USER_KEY"),
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

    it("POSTs to the Pushover API endpoint", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.pushover.net/1/messages.json");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends JSON with Content-Type header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends correct payload with token, user, title, and message", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      await notifier.notify(makeEvent({ sessionId: "backend-3" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.token).toBe("app-token");
      expect(body.user).toBe("user-key");
      expect(body.title).toContain("backend-3");
      expect(body.message).toBe("Session app-1 spawned successfully");
      expect(body.html).toBe(1);
    });

    it("maps priority to correct Pushover priority value", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();

      const priorities: Array<[EventPriority, number]> = [
        ["urgent", 2],
        ["action", 1],
        ["warning", 0],
        ["info", -1],
      ];

      for (const [priority, pushoverPriority] of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.priority).toBe(pushoverPriority);
      }
    });

    it("includes retry and expire for urgent (emergency) priority", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.retry).toBe(300);
      expect(body.expire).toBe(3600);
    });

    it("does not include retry and expire for non-urgent priority", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      await notifier.notify(makeEvent({ priority: "info" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.retry).toBeUndefined();
      expect(body.expire).toBeUndefined();
    });

    it("includes PR url when prUrl is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      await notifier.notify(
        makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.url).toBe("https://github.com/org/repo/pull/42");
      expect(body.url_title).toBe("View PR");
    });

    it("ignores prUrl when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.url).toBeUndefined();
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Pushover API failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("uses first action with url as the Pushover url", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.url).toBe("https://github.com/org/repo/pull/42/merge");
      expect(body.url_title).toBe("Merge");
    });

    it("skips actions without url to find first valid one", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.url).toBe("https://example.com");
      expect(body.url_title).toBe("Merge");
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
    it("sends a plain text message with 'Agent Orchestrator' title", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.title).toBe("Agent Orchestrator");
      expect(body.message).toBe("Hello from AO");
      expect(body.priority).toBe(-1); // info maps to -1
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
      process.env.PUSHOVER_APP_TOKEN = "app-token";
      process.env.PUSHOVER_USER_KEY = "user-key";

      const notifier = create();
      await expect(notifier.post!("test")).rejects.toThrow(
        "Pushover API failed (400): bad request",
      );
    });
  });
});
