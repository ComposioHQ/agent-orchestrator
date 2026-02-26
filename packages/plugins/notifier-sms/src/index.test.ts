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

describe("notifier-sms", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("sms");
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
    it("returns a notifier with name 'sms'", () => {
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";
      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      expect(notifier.name).toBe("sms");
    });

    it("warns when Twilio credentials or phone numbers are missing", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing TWILIO_ACCOUNT_SID"),
      );
    });

    it("warns when to/from phone numbers are missing", () => {
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing"),
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

    it("POSTs to the Twilio Messages API endpoint", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json",
      );
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("sends URL-encoded body with Content-Type header", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    });

    it("includes Basic auth header with base64-encoded credentials", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      const expected = btoa("AC123:auth-token");
      expect(opts.headers.Authorization).toBe(`Basic ${expected}`);
    });

    it("sends To, From, and Body URL-encoded parameters", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await notifier.notify(makeEvent());

      const bodyStr = fetchMock.mock.calls[0][1].body as string;
      const params = new URLSearchParams(bodyStr);
      expect(params.get("To")).toBe("+1234567890");
      expect(params.get("From")).toBe("+0987654321");
      expect(params.get("Body")).toBeDefined();
    });

    it("includes session ID and event type in SMS body", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await notifier.notify(makeEvent({ sessionId: "backend-3" }));

      const bodyStr = fetchMock.mock.calls[0][1].body as string;
      const params = new URLSearchParams(bodyStr);
      const smsBody = params.get("Body") as string;
      expect(smsBody).toContain("backend-3");
      expect(smsBody).toContain("session.spawned");
    });

    it("includes project in SMS body", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await notifier.notify(makeEvent({ projectId: "frontend" }));

      const bodyStr = fetchMock.mock.calls[0][1].body as string;
      const params = new URLSearchParams(bodyStr);
      const smsBody = params.get("Body") as string;
      expect(smsBody).toContain("Project: frontend");
    });

    it("includes PR link when prUrl is a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await notifier.notify(
        makeEvent({ data: { prUrl: "https://github.com/org/repo/pull/42" } }),
      );

      const bodyStr = fetchMock.mock.calls[0][1].body as string;
      const params = new URLSearchParams(bodyStr);
      const smsBody = params.get("Body") as string;
      expect(smsBody).toContain("PR: https://github.com/org/repo/pull/42");
    });

    it("ignores prUrl when it is not a string", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await notifier.notify(makeEvent({ data: { prUrl: 12345 } }));

      const bodyStr = fetchMock.mock.calls[0][1].body as string;
      const params = new URLSearchParams(bodyStr);
      const smsBody = params.get("Body") as string;
      expect(smsBody).not.toContain("PR:");
    });

    it("throws on non-ok response", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      });
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "Twilio API failed (500): server error",
      );
    });
  });

  describe("notifyWithActions", () => {
    it("includes action URLs in SMS body", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/org/repo/pull/42/merge" },
        { label: "Open", url: "https://github.com/org/repo/pull/42" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const bodyStr = fetchMock.mock.calls[0][1].body as string;
      const params = new URLSearchParams(bodyStr);
      const smsBody = params.get("Body") as string;
      expect(smsBody).toContain("Merge: https://github.com/org/repo/pull/42/merge");
      expect(smsBody).toContain("Open: https://github.com/org/repo/pull/42");
    });

    it("filters out actions with no url", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      const actions: NotifyAction[] = [
        { label: "No-op" },
        { label: "Merge", url: "https://example.com" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const bodyStr = fetchMock.mock.calls[0][1].body as string;
      const params = new URLSearchParams(bodyStr);
      const smsBody = params.get("Body") as string;
      expect(smsBody).toContain("Merge: https://example.com");
      expect(smsBody).not.toContain("No-op:");
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
    it("sends a plain text SMS", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      const result = await notifier.post!("Hello from AO");

      const bodyStr = fetchMock.mock.calls[0][1].body as string;
      const params = new URLSearchParams(bodyStr);
      expect(params.get("Body")).toBe("Hello from AO");
      expect(result).toBeNull();
    });

    it("truncates messages longer than 1500 chars", async () => {
      const fetchMock = mockFetchOk();
      vi.stubGlobal("fetch", fetchMock);
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      const longMsg = "a".repeat(2000);
      await notifier.post!(longMsg);

      const bodyStr = fetchMock.mock.calls[0][1].body as string;
      const params = new URLSearchParams(bodyStr);
      const smsBody = params.get("Body") as string;
      expect(smsBody.length).toBe(1500);
      expect(smsBody).toMatch(/\.\.\.$/);
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
      process.env.TWILIO_ACCOUNT_SID = "AC123";
      process.env.TWILIO_AUTH_TOKEN = "auth-token";

      const notifier = create({ to: "+1234567890", from: "+0987654321" });
      await expect(notifier.post!("test")).rejects.toThrow(
        "Twilio API failed (400): bad request",
      );
    });
  });
});
