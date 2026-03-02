import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrchestratorEvent } from "@composio/ao-core";
import { manifest, create } from "./index.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "ci.failing",
    priority: "action",
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-06-15T12:00:00Z"),
    message: "CI check failed on app-1",
    data: { branch: "feat/add-login", status: "failing" },
    ...overrides,
  };
}

describe("notifier-openclaw", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("openclaw");
      expect(manifest.slot).toBe("notifier");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create", () => {
    it("returns a notifier with name 'openclaw'", () => {
      const notifier = create({ host: "localhost", port: 8080, token: "tok123" });
      expect(notifier.name).toBe("openclaw");
    });

    it("warns when no token configured", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      create();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No token configured"));
    });

    it("uses default host and port when not provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123" });
      await notifier.notify(makeEvent());

      expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8080/api/sessions/main/message");
    });
  });

  describe("notify", () => {
    it("does nothing when no token", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const notifier = create();
      await notifier.notify(makeEvent());
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POSTs message to the OpenClaw gateway", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ host: "myhost", port: 9000, token: "tok123" });
      await notifier.notify(makeEvent());

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe("http://myhost:9000/api/sessions/main/message");

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.headers["Authorization"]).toBe("Bearer tok123");

      const body = JSON.parse(opts.body);
      expect(body.message).toContain("my-project");
      expect(body.message).toContain("app-1");
      expect(body.message).toContain("CI check failed on app-1");
    });

    it("includes session ID, project, branch, and status in message", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123" });
      await notifier.notify(makeEvent());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.message).toContain("[my-project/app-1]");
      expect(body.message).toContain("(feat/add-login)");
      expect(body.message).toContain("status=failing");
      expect(body.message).toContain("CI check failed on app-1");
    });

    it("omits branch when not in event data", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123" });
      await notifier.notify(makeEvent({ data: {} }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.message).not.toContain("(");
      expect(body.message).toContain("[my-project/app-1]");
    });

    it("omits status when not in event data", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123" });
      await notifier.notify(makeEvent({ data: {} }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.message).not.toContain("status=");
    });

    it("skips events not in the default allowed set", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123" });
      await notifier.notify(makeEvent({ type: "session.working" }));

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends events that are in the default allowed set", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123" });

      for (const type of [
        "session.spawned",
        "session.exited",
        "ci.failing",
        "pr.created",
        "merge.ready",
        "summary.all_complete",
      ] as const) {
        await notifier.notify(makeEvent({ type }));
      }

      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it("respects custom events filter", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({
        token: "tok123",
        events: ["session.spawned", "session.exited"],
      });

      await notifier.notify(makeEvent({ type: "session.spawned" }));
      expect(fetchMock).toHaveBeenCalledOnce();

      await notifier.notify(makeEvent({ type: "ci.failing" }));
      expect(fetchMock).toHaveBeenCalledOnce(); // still 1, ci.failing filtered out
    });
  });

  describe("retry logic", () => {
    it("retries on 5xx and succeeds", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: () => Promise.resolve("unavailable"),
        })
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123", retries: 2, retryDelayMs: 1 });
      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries on 429 Too Many Requests", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve("rate limited"),
        })
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123", retries: 2, retryDelayMs: 1 });
      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on 400 Bad Request", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve("bad request") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123", retries: 2, retryDelayMs: 1 });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("OpenClaw POST failed (400)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry on 401 Unauthorized", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123", retries: 2, retryDelayMs: 1 });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("OpenClaw POST failed (401)");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws after all retries exhausted on 5xx", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("error") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123", retries: 2, retryDelayMs: 1 });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "OpenClaw POST failed (500): error",
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries on network errors", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123", retries: 1, retryDelayMs: 1 });
      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("respects retries=0 (no retries)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("fail") });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123", retries: 0, retryDelayMs: 1 });
      await expect(notifier.notify(makeEvent())).rejects.toThrow("OpenClaw POST failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetch timeout", () => {
    it("passes an AbortSignal to fetch", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123" });
      await notifier.notify(makeEvent());

      const opts = fetchMock.mock.calls[0][1];
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it("treats abort as a retryable network error", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"))
        .mockResolvedValueOnce({ ok: true });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123", retries: 1, retryDelayMs: 1 });
      await notifier.notify(makeEvent());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("response.text() guard", () => {
    it("uses fallback when response.text() throws", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.reject(new Error("body stream already read")),
      });
      vi.stubGlobal("fetch", fetchMock);

      const notifier = create({ token: "tok123", retries: 0, retryDelayMs: 1 });
      await expect(notifier.notify(makeEvent())).rejects.toThrow(
        "OpenClaw POST failed (400): <unreadable response body>",
      );
    });
  });
});
