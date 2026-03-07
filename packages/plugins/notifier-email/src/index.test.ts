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

describe("notifier-email", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("email");
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
    it("returns a notifier with name 'email'", () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const notifier = create({ to: ["user@example.com"] });
      expect(notifier.name).toBe("email");
    });

    it("warns when RESEND_API_KEY is missing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create({ to: ["user@example.com"] });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing RESEND_API_KEY or to addresses"),
      );
    });

    it("warns when to addresses are missing", () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing RESEND_API_KEY or to addresses"),
      );
    });

    it("warns when to is an empty array", () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create({ to: [] });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing RESEND_API_KEY or to addresses"),
      );
    });

    it("filters non-string values from to array", () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Pass non-string values; they should be filtered out, leaving empty array
      create({ to: [123, null, undefined] });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing RESEND_API_KEY or to addresses"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("notify", () => {
    it("does nothing when API key is missing", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create({ to: ["user@example.com"] });
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does nothing when to addresses are empty", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create({ to: [] });
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("POSTs to the Resend API endpoint", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.resend.com/emails");
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends Authorization header with Bearer token", async () => {
      process.env.RESEND_API_KEY = "re_test_key_123";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Authorization"]).toBe("Bearer re_test_key_123");
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends correct to, from, subject fields", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        to: ["alice@example.com", "bob@example.com"],
        from: "MyBot <bot@example.com>",
      });
      await notifier.notify(makeEvent({ priority: "urgent", sessionId: "deploy-1" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.to).toEqual(["alice@example.com", "bob@example.com"]);
      expect(body.from).toBe("MyBot <bot@example.com>");
      expect(body.subject).toContain("[URGENT]");
      expect(body.subject).toContain("deploy-1");
    });

    it("uses default from address when not configured", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.from).toBe("Agent Orchestrator <ao@notifications.example.com>");
    });

    it("includes priority emoji in subject", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });

      const priorities: Array<[EventPriority, string]> = [
        ["urgent", "URGENT"],
        ["action", "ACTION"],
        ["warning", "WARNING"],
        ["info", "INFO"],
      ];

      for (const [priority, label] of priorities) {
        fetchMock.mockClear();
        await notifier.notify(makeEvent({ priority }));
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.subject).toContain(`[${label}]`);
      }
    });

    it("includes event message in HTML body", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await notifier.notify(makeEvent({ message: "CI is green" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).toContain("CI is green");
    });

    it("includes project, session, priority in HTML table", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await notifier.notify(
        makeEvent({ projectId: "frontend", sessionId: "ui-1", priority: "warning" }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).toContain("frontend");
      expect(body.html).toContain("ui-1");
      expect(body.html).toContain("warning");
    });

    it("includes PR link when prUrl is a string", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await notifier.notify(makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).toContain("View Pull Request");
      expect(body.html).toContain("https://github.com/org/repo/pull/42");
    });

    it("ignores prUrl when it is not a string", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).not.toContain("View Pull Request");
    });

    it("includes CI status when ciStatus is a string", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await notifier.notify(makeEvent({ data: { ciStatus: "passing" } }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).toContain("passing");
      expect(body.html).toContain("CI");
    });

    it("throws on non-ok response", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Unprocessable Entity"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Resend API failed (422): Unprocessable Entity",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes action buttons as styled links in HTML", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).toContain("Merge");
      expect(body.html).toContain("https://github.com/org/repo/pull/42/merge");
      expect(body.html).toContain("Open");
    });

    it("filters out actions without URL", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Callback", callbackEndpoint: "/api/sessions/app-1/kill" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.html).toContain("Merge");
      expect(body.html).not.toContain(">No-op<");
      expect(body.html).not.toContain(">Callback<");
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
    it("sends a plain text message as email", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      const result = await notifier.post!("Hello from AO");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.subject).toBe("Agent Orchestrator Notification");
      expect(body.html).toContain("Hello from AO");
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
      process.env.RESEND_API_KEY = "re_test_key";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ to: ["user@example.com"] });
      await expect(notifier.post!("test")).rejects.toThrow(
        "Resend API failed (500): Internal Server Error",
      );
    });
  });
});
