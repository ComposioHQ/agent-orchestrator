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

describe("notifier-mattermost", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("mattermost");
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
    it("returns a notifier with name 'mattermost'", () => {
      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      expect(notifier.name).toBe("mattermost");
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
        create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" }),
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

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://mattermost.example.com/hooks/xxx");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends JSON with Content-Type header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends payload with attachments array", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.attachments).toBeDefined();
      expect(body.attachments).toHaveLength(1);
    });

    it("includes session ID in attachment title", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await notifier.notify(makeEvent({ sessionId: "backend-3" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.attachments[0].title).toContain("backend-3");
    });

    it("uses correct color for each priority level", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });

      const priorities: Array<[EventPriority, string]> = [
        ["urgent", "#FF0000"],
        ["action", "#FF9900"],
        ["warning", "#FFCC00"],
        ["info", "#3498DB"],
      ];

      for (const [priority, color] of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.attachments[0].color).toBe(color);
      }
    });

    it("includes fields for project and priority", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await notifier.notify(
        makeEvent({ projectId: "frontend", priority: "action" }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const fields = body.attachments[0].fields;
      expect(fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Project", value: "frontend" }),
          expect.objectContaining({ title: "Priority", value: "action" }),
        ]),
      );
    });

    it("includes PR link in attachment text when prUrl is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await notifier.notify(
        makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.attachments[0].text).toContain("https://github.com/org/repo/pull/42");
    });

    it("ignores prUrl when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.attachments[0].text).not.toContain("Pull Request");
    });

    it("includes default username 'Agent Orchestrator'", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.username).toBe("Agent Orchestrator");
    });

    it("uses custom username when provided", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://mattermost.example.com/hooks/xxx",
        username: "MyBot",
      });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.username).toBe("MyBot");
    });

    it("includes channel when configured", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://mattermost.example.com/hooks/xxx",
        channel: "dev-alerts",
      });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.channel).toBe("dev-alerts");
    });

    it("includes timestamp in attachment", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.attachments[0].ts).toBe(
        Math.floor(new Date("2025-06-15T12:00:00Z").getTime() / 1000),
      );
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Mattermost webhook failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes action links in attachment text", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const text = body.attachments[0].text as string;
      expect(text).toContain("[Merge]");
      expect(text).toContain("[Open]");
      expect(text).toContain("https://github.com/org/repo/pull/42/merge");
    });

    it("filters out actions with no url", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const text = body.attachments[0].text as string;
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
    it("sends a plain text message", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.text).toBe("Hello from AO");
      expect(body.username).toBe("Agent Orchestrator");
      expect(result).toBeNull();
    });

    it("uses context channel over config channel", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://mattermost.example.com/hooks/xxx",
        channel: "default-channel",
      });
      await notifier.post!("test", { channel: "override-channel" });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.channel).toBe("override-channel");
    });

    it("falls back to config channel when context has no channel", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        webhookUrl: "https://mattermost.example.com/hooks/xxx",
        channel: "default-channel",
      });
      await notifier.post!("test");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.channel).toBe("default-channel");
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

      const notifier = create({ webhookUrl: "https://mattermost.example.com/hooks/xxx" });
      await expect(notifier.post!("test")).rejects.toThrow(
        "Mattermost webhook failed (400): bad request",
      );
    });
  });
});
