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

describe("notifier-ntfy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("ntfy");
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
    it("returns a notifier with name 'ntfy'", () => {
      const notifier = create({ topic: "ao-alerts" });
      expect(notifier.name).toBe("ntfy");
    });

    it("warns when no topic configured", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("No topic configured"),
      );
    });

    it("uses default base URL https://ntfy.sh when url not provided", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      await notifier.notify(makeEvent());

      expect(fetchMock.mock.calls[0][0]).toBe("https://ntfy.sh/ao-alerts");
    });

    it("uses custom base URL when provided", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts", url: "https://ntfy.example.com" });
      await notifier.notify(makeEvent());

      expect(fetchMock.mock.calls[0][0]).toBe("https://ntfy.example.com/ao-alerts");
    });

    it("strips trailing slashes from custom URL", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts", url: "https://ntfy.example.com///" });
      await notifier.notify(makeEvent());

      expect(fetchMock.mock.calls[0][0]).toBe("https://ntfy.example.com/ao-alerts");
    });
  });

  describe("notify", () => {
    it("does nothing when no topic", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("POSTs to the ntfy topic URL", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://ntfy.sh/ao-alerts");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends message as plain body text", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.body).toBe("Session app-1 spawned successfully");
    });

    it("includes Title header with session ID", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      await notifier.notify(makeEvent({ sessionId: "backend-3" }));

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Title).toContain("backend-3");
    });

    it("maps priority to correct ntfy priority header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });

      const priorities: Array<[EventPriority, string]> = [
        ["urgent", "5"],
        ["action", "4"],
        ["warning", "3"],
        ["info", "2"],
      ];

      for (const [priority, ntfyPriority] of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const headers = fetchMock.mock.calls[0][1].headers;
        expect(headers.Priority).toBe(ntfyPriority);
      }
    });

    it("maps priority to correct ntfy Tags header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });

      const priorities: Array<[EventPriority, string]> = [
        ["urgent", "rotating_light"],
        ["action", "point_right"],
        ["warning", "warning"],
        ["info", "information_source"],
      ];

      for (const [priority, tag] of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const headers = fetchMock.mock.calls[0][1].headers;
        expect(headers.Tags).toBe(tag);
      }
    });

    it("does not include Actions header when no actions", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      await notifier.notify(makeEvent());

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Actions).toBeUndefined();
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "ntfy POST failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes Actions header with action links", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Actions).toBeDefined();
      expect(headers.Actions).toContain("Merge");
      expect(headers.Actions).toContain("Open");
      expect(headers.Actions).toContain("https://github.com/org/repo/pull/42/merge");
    });

    it("filters out actions with no url", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Actions).toContain("Merge");
      expect(headers.Actions).not.toContain("No-op");
      // Must not end with a trailing semicolon
      expect(headers.Actions).not.toMatch(/;$/);
    });

    it("uses correct semicolon separator between multiple actions", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com/merge" },
        { label: "Open", url: "https://example.com/open" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const headers = fetchMock.mock.calls[0][1].headers;
      // "No-op" has no URL so only 2 actions; must end with the last action URL, no trailing ";"
      expect(headers.Actions).toBe(
        "view, Merge, https://example.com/merge; view, Open, https://example.com/open",
      );
    });

    it("does nothing when no topic", async () => {
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

      const notifier = create({ topic: "ao-alerts" });
      const result = await notifier.post!("Hello from AO");

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.body).toBe("Hello from AO");
      expect(opts.headers.Title).toBe("Agent Orchestrator");
      expect(result).toBeNull();
    });

    it("uses info priority for plain messages", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ topic: "ao-alerts" });
      await notifier.post!("test");

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers.Priority).toBe("2");
    });

    it("returns null when no topic", async () => {
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

      const notifier = create({ topic: "ao-alerts" });
      await expect(notifier.post!("test")).rejects.toThrow(
        "ntfy POST failed (400): bad request",
      );
    });
  });
});
