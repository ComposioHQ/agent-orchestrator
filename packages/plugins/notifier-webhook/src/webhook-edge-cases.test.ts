/**
 * Edge case tests for the webhook notifier plugin.
 * Covers retry logic, status code handling, and error resilience.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OrchestratorEvent } from "@composio/ao-core";
import webhookPlugin from "./index.js";

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.working",
    priority: "info",
    sessionId: "app-1",
    projectId: "my-app",
    timestamp: new Date("2025-01-01T00:00:00Z"),
    message: "Test event",
    data: {},
    ...overrides,
  };
}

describe("notifier-webhook edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports correct manifest", () => {
    expect(webhookPlugin.manifest.name).toBe("webhook");
    expect(webhookPlugin.manifest.slot).toBe("notifier");
  });

  describe("create and notify", () => {
    it("sends POST request to webhook URL with correct payload structure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("ok"),
      });

      const notifier = webhookPlugin.create({ url: "https://example.com/hook" });
      const event = makeEvent();

      await notifier.notify(event);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://example.com/hook");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(opts.body);
      // Payload structure: { type: "notification", event: { ... } }
      expect(body.type).toBe("notification");
      expect(body.event.type).toBe("session.working");
      expect(body.event.sessionId).toBe("app-1");
    });

    it("retries on 5xx errors", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("ok"),
        });

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 3,
        retryDelayMs: 100,
      });

      const notifyPromise = notifier.notify(makeEvent());
      await vi.advanceTimersByTimeAsync(200);
      await notifyPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does not retry on 4xx errors", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad Request"),
      });

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 3,
        retryDelayMs: 100,
      });

      await expect(notifier.notify(makeEvent())).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("retries on 429 rate limit", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          text: () => Promise.resolve("Too Many Requests"),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("ok"),
        });

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 3,
        retryDelayMs: 100,
      });

      const notifyPromise = notifier.notify(makeEvent());
      await vi.advanceTimersByTimeAsync(200);
      await notifyPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on network errors (fetch throws)", async () => {
      mockFetch
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: () => Promise.resolve("ok"),
        });

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 3,
        retryDelayMs: 100,
      });

      const notifyPromise = notifier.notify(makeEvent());
      await vi.advanceTimersByTimeAsync(200);
      await notifyPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("gives up after exhausting all retries", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("Service Unavailable"),
      });

      const notifier = webhookPlugin.create({
        url: "https://example.com/hook",
        retries: 2,
        retryDelayMs: 50,
      });

      // Capture rejection immediately to prevent unhandled rejection warning
      let caughtError: Error | undefined;
      const notifyPromise = notifier.notify(makeEvent()).catch((e: Error) => {
        caughtError = e;
      });

      // Advance enough time for all retries: 50ms + 100ms
      await vi.advanceTimersByTimeAsync(1000);
      await notifyPromise;

      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError!.message).toContain("Webhook POST failed");

      // 1 initial + 2 retries = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("event data serialization", () => {
    it("includes all event fields in request body under event key", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve("ok"),
      });

      const notifier = webhookPlugin.create({ url: "https://example.com/hook" });
      const event = makeEvent({
        type: "ci.failing",
        priority: "warning",
        data: { prUrl: "https://github.com/org/repo/pull/42" },
      });

      await notifier.notify(event);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.type).toBe("notification");
      expect(body.event.type).toBe("ci.failing");
      expect(body.event.priority).toBe("warning");
      expect(body.event.data.prUrl).toBe("https://github.com/org/repo/pull/42");
    });
  });
});
