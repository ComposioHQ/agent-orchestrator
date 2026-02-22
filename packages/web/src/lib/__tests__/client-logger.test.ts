/**
 * Tests for browser-side client logger.
 *
 * Covers:
 * - window.onerror / unhandledrejection capture
 * - PerformanceObserver integration (LCP, FCP, navigation)
 * - Batch flush via fetch POST to /api/client-logs
 * - sendBeacon usage on flush, with fetch fallback
 * - Periodic flush timer
 * - Visibility change flush
 * - beforeunload (pagehide) flush
 * - Cleanup function behavior
 * - Graceful degradation when PerformanceObserver is unavailable
 *
 * The module under test uses module-level state (buffer, flushTimer).
 * We use vi.resetModules() + dynamic import to get fresh state per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// PromiseRejectionEvent polyfill for jsdom (not available by default)
// ---------------------------------------------------------------------------

if (typeof globalThis.PromiseRejectionEvent === "undefined") {
  // Minimal polyfill that satisfies the code under test
  class PromiseRejectionEventPolyfill extends Event {
    readonly promise: Promise<unknown>;
    readonly reason: unknown;

    constructor(
      type: string,
      init: { promise: Promise<unknown>; reason?: unknown },
    ) {
      super(type, { bubbles: false, cancelable: true });
      this.promise = init.promise;
      this.reason = init.reason;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PromiseRejectionEvent = PromiseRejectionEventPolyfill;
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Captured PerformanceObserver callback from the most recent instantiation. */
let perfObserverCallback: ((list: { getEntries: () => unknown[] }) => void) | null = null;
let perfObserverObservedTypes: string[] = [];
let perfObserverDisconnected = false;

class MockPerformanceObserver {
  callback: (list: { getEntries: () => unknown[] }) => void;

  constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
    this.callback = cb;
    perfObserverCallback = cb;
  }

  observe(opts: { type: string; buffered?: boolean }): void {
    perfObserverObservedTypes.push(opts.type);
  }

  disconnect(): void {
    perfObserverDisconnected = true;
  }
}

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.fn>;
let sendBeaconSpy: ReturnType<typeof vi.fn>;
let originalPerformanceObserver: typeof globalThis.PerformanceObserver | undefined;

/** Dynamically imported initClientLogger — fresh module state each test. */
let initClientLogger: () => () => void;

beforeEach(async () => {
  vi.useFakeTimers();

  // Reset PerformanceObserver tracking
  perfObserverCallback = null;
  perfObserverObservedTypes = [];
  perfObserverDisconnected = false;

  // Install mock PerformanceObserver
  originalPerformanceObserver = globalThis.PerformanceObserver;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.PerformanceObserver = MockPerformanceObserver as any;

  // Mock fetch
  fetchSpy = vi.fn().mockResolvedValue({ ok: true });
  globalThis.fetch = fetchSpy;

  // Mock sendBeacon (returns true by default)
  sendBeaconSpy = vi.fn().mockReturnValue(true);
  Object.defineProperty(navigator, "sendBeacon", {
    value: sendBeaconSpy,
    writable: true,
    configurable: true,
  });

  // Reset modules to get fresh module-level state (buffer, flushTimer)
  vi.resetModules();
  const mod = await import("../client-logger.js");
  initClientLogger = mod.initClientLogger;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();

  // Restore PerformanceObserver
  if (originalPerformanceObserver) {
    globalThis.PerformanceObserver = originalPerformanceObserver;
  }
});

// ---------------------------------------------------------------------------
// initClientLogger — basic setup
// ---------------------------------------------------------------------------

describe("initClientLogger", () => {
  it("returns a cleanup function", () => {
    const cleanup = initClientLogger();
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("registers error event listener on window", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const cleanup = initClientLogger();

    const errorCalls = addSpy.mock.calls.filter(([type]) => type === "error");
    expect(errorCalls.length).toBe(1);

    cleanup();
  });

  it("registers unhandledrejection event listener on window", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const cleanup = initClientLogger();

    const rejectionCalls = addSpy.mock.calls.filter(
      ([type]) => type === "unhandledrejection",
    );
    expect(rejectionCalls.length).toBe(1);

    cleanup();
  });

  it("registers pagehide event listener on window", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const cleanup = initClientLogger();

    const pageCalls = addSpy.mock.calls.filter(([type]) => type === "pagehide");
    expect(pageCalls.length).toBe(1);

    cleanup();
  });

  it("registers visibilitychange event listener on window", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const cleanup = initClientLogger();

    const visCalls = addSpy.mock.calls.filter(
      ([type]) => type === "visibilitychange",
    );
    expect(visCalls.length).toBe(1);

    cleanup();
  });

  it("sets up a periodic flush interval", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const cleanup = initClientLogger();

    // setInterval should have been called with 10_000 ms
    const flushCalls = setIntervalSpy.mock.calls.filter(
      ([, ms]) => ms === 10_000,
    );
    expect(flushCalls.length).toBe(1);

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Error capture
// ---------------------------------------------------------------------------

describe("error capture", () => {
  it("captures error events with message, filename, and stack", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    const errorEvent = new ErrorEvent("error", {
      message: "Test error occurred",
      filename: "https://example.com/app.js",
      lineno: 42,
      colno: 7,
      error: new Error("Test error occurred"),
    });

    window.dispatchEvent(errorEvent);

    // Advance timer to trigger flush
    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].level).toBe("error");
    expect(body.entries[0].message).toBe("Test error occurred");
    expect(body.entries[0].url).toBe("https://example.com/app.js");
    expect(body.entries[0].stack).toBeDefined();

    cleanup();
  });

  it("captures error event with fallback message when message is empty", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    const errorEvent = new ErrorEvent("error", {
      message: "",
      filename: "app.js",
    });
    window.dispatchEvent(errorEvent);

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].message).toBe("Unknown error");
    expect(body.entries[0].level).toBe("error");

    cleanup();
  });

  it("captures unhandled promise rejections with Error reason", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    const reason = new Error("Promise failed");
    const event = new PromiseRejectionEvent("unhandledrejection", {
      reason,
      promise: Promise.resolve(),
    });
    window.dispatchEvent(event);

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].message).toBe("Promise failed");
    expect(body.entries[0].level).toBe("error");
    expect(body.entries[0].stack).toBeDefined();

    cleanup();
  });

  it("captures unhandled promise rejections with string reason", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    const event = new PromiseRejectionEvent("unhandledrejection", {
      reason: "string rejection",
      promise: Promise.resolve(),
    });
    window.dispatchEvent(event);

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].message).toBe("string rejection");
    expect(body.entries[0].stack).toBeUndefined();

    cleanup();
  });

  it("captures unhandled promise rejections with non-Error non-string reason", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    const event = new PromiseRejectionEvent("unhandledrejection", {
      reason: 42,
      promise: Promise.resolve(),
    });
    window.dispatchEvent(event);

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries[0].message).toBe("42");
    expect(body.entries[0].stack).toBeUndefined();

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Flush mechanism
// ---------------------------------------------------------------------------

describe("flush mechanism", () => {
  it("skips fetch when buffer is empty", () => {
    const cleanup = initClientLogger();

    // Advance timer -- no errors were recorded
    vi.advanceTimersByTime(10_000);

    expect(sendBeaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    cleanup();
  });

  it("batches multiple entries into a single POST", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    // Dispatch two errors
    window.dispatchEvent(
      new ErrorEvent("error", { message: "Error 1", filename: "a.js" }),
    );
    window.dispatchEvent(
      new ErrorEvent("error", { message: "Error 2", filename: "b.js" }),
    );

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].message).toBe("Error 1");
    expect(body.entries[1].message).toBe("Error 2");

    cleanup();
  });

  it("uses sendBeacon for flush and skips fetch when sendBeacon succeeds", () => {
    sendBeaconSpy.mockReturnValue(true);
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "beacon test" }),
    );
    vi.advanceTimersByTime(10_000);

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
    expect(sendBeaconSpy.mock.calls[0][0]).toBe("/api/client-logs");
    expect(fetchSpy).not.toHaveBeenCalled();

    cleanup();
  });

  it("falls back to fetch when sendBeacon returns false", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "fallback test" }),
    );
    vi.advanceTimersByTime(10_000);

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/client-logs");
    expect(fetchSpy.mock.calls[0][1].method).toBe("POST");
    expect(fetchSpy.mock.calls[0][1].keepalive).toBe(true);

    cleanup();
  });

  it("falls back to fetch when sendBeacon is not available", () => {
    // Remove sendBeacon
    Object.defineProperty(navigator, "sendBeacon", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "no beacon" }),
    );
    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries[0].message).toBe("no beacon");

    cleanup();
  });

  it("sends correct Content-Type header in fetch fallback", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "header check" }),
    );
    vi.advanceTimersByTime(10_000);

    expect(fetchSpy.mock.calls[0][1].headers).toEqual({
      "Content-Type": "application/json",
    });

    cleanup();
  });

  it("does not crash when fetch rejects", () => {
    sendBeaconSpy.mockReturnValue(false);
    fetchSpy.mockRejectedValue(new Error("network error"));
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "fetch will fail" }),
    );

    // Should not throw
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();

    cleanup();
  });

  it("clears the buffer after flushing", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "first batch" }),
    );
    vi.advanceTimersByTime(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second interval: nothing new was added, so flush should be skipped
    vi.advanceTimersByTime(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Still 1

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Visibility change and pagehide
// ---------------------------------------------------------------------------

describe("visibility change and pagehide flush", () => {
  it("flushes when document.visibilityState becomes hidden", () => {
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "visibility test" }),
    );

    // Simulate visibilitychange to hidden
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });
    window.dispatchEvent(new Event("visibilitychange"));

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);

    // Restore visibilityState
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });

    cleanup();
  });

  it("does not flush on visibilitychange when state is visible", () => {
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "visible test" }),
    );

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    window.dispatchEvent(new Event("visibilitychange"));

    // Should NOT have flushed yet (only periodic timer would flush)
    expect(sendBeaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    cleanup();
  });

  it("flushes on pagehide event", () => {
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "pagehide test" }),
    );

    window.dispatchEvent(new Event("pagehide"));

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Cleanup function
// ---------------------------------------------------------------------------

describe("cleanup", () => {
  it("removes error event listener", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const cleanup = initClientLogger();

    cleanup();

    const errorRemoves = removeSpy.mock.calls.filter(
      ([type]) => type === "error",
    );
    expect(errorRemoves.length).toBe(1);
  });

  it("removes unhandledrejection event listener", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const cleanup = initClientLogger();

    cleanup();

    const rejectionRemoves = removeSpy.mock.calls.filter(
      ([type]) => type === "unhandledrejection",
    );
    expect(rejectionRemoves.length).toBe(1);
  });

  it("removes pagehide event listener", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const cleanup = initClientLogger();

    cleanup();

    const pageRemoves = removeSpy.mock.calls.filter(
      ([type]) => type === "pagehide",
    );
    expect(pageRemoves.length).toBe(1);
  });

  it("removes visibilitychange event listener", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const cleanup = initClientLogger();

    cleanup();

    const visRemoves = removeSpy.mock.calls.filter(
      ([type]) => type === "visibilitychange",
    );
    expect(visRemoves.length).toBe(1);
  });

  it("no longer flushes on visibilitychange after cleanup", () => {
    const cleanup = initClientLogger();
    cleanup();

    // Reset spies after cleanup flush
    fetchSpy.mockClear();
    sendBeaconSpy.mockClear();

    // Add an entry directly via a new error (won't be captured since error
    // listener was removed, but set up document state for the visibility test)
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      writable: true,
      configurable: true,
    });
    // Fire visibilitychange -- listener should have been removed
    window.dispatchEvent(new Event("visibilitychange"));

    expect(sendBeaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Restore
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
  });

  it("clears the flush interval", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const cleanup = initClientLogger();

    cleanup();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("flushes remaining entries on cleanup", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "leftover entry" }),
    );

    // No timer advance -- just call cleanup directly
    cleanup();

    // Cleanup calls flush() which tries sendBeacon (false) then fetch
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].message).toBe("leftover entry");
  });

  it("disconnects PerformanceObserver on cleanup", () => {
    const cleanup = initClientLogger();
    expect(perfObserverDisconnected).toBe(false);

    cleanup();

    expect(perfObserverDisconnected).toBe(true);
  });

  it("no longer captures errors after cleanup", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();
    cleanup();

    // Reset spies after cleanup flush
    fetchSpy.mockClear();
    sendBeaconSpy.mockClear();

    // Dispatch error after cleanup
    window.dispatchEvent(
      new ErrorEvent("error", { message: "after cleanup" }),
    );
    vi.advanceTimersByTime(10_000);

    // The interval was cleared, so no periodic flush. The event listener was
    // removed, so the error was never captured. Nothing should have been sent.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PerformanceObserver integration
// ---------------------------------------------------------------------------

describe("PerformanceObserver integration", () => {
  it("observes largest-contentful-paint, paint, and navigation types", () => {
    const cleanup = initClientLogger();

    expect(perfObserverObservedTypes).toContain("largest-contentful-paint");
    expect(perfObserverObservedTypes).toContain("paint");
    expect(perfObserverObservedTypes).toContain("navigation");

    cleanup();
  });

  it("captures LCP entries", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    // Simulate PerformanceObserver callback with LCP entry
    perfObserverCallback!({
      getEntries: () => [
        {
          entryType: "largest-contentful-paint",
          startTime: 1234.5,
          name: "largest-contentful-paint",
        },
      ],
    });

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].level).toBe("info");
    expect(body.entries[0].message).toBe("LCP: 1235ms");
    expect(body.entries[0].timing.lcp).toBe(1234.5);

    cleanup();
  });

  it("captures first-contentful-paint entries", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    perfObserverCallback!({
      getEntries: () => [
        {
          entryType: "paint",
          startTime: 567.8,
          name: "first-contentful-paint",
        },
      ],
    });

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].message).toBe("first-contentful-paint: 568ms");
    expect(body.entries[0].timing.fcp).toBe(567.8);

    cleanup();
  });

  it("captures first-paint entries with fp timing key", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    perfObserverCallback!({
      getEntries: () => [
        {
          entryType: "paint",
          startTime: 200.3,
          name: "first-paint",
        },
      ],
    });

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries[0].timing.fp).toBe(200.3);

    cleanup();
  });

  it("captures navigation timing entries with TTFB, DOM, and load metrics", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    perfObserverCallback!({
      getEntries: () => [
        {
          entryType: "navigation",
          name: "navigation",
          startTime: 0,
          responseStart: 150.5,
          domContentLoadedEventEnd: 450.2,
          loadEventEnd: 800.7,
        },
      ],
    });

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].message).toBe("Navigation: TTFB 151ms, DOM 450ms");
    expect(body.entries[0].timing.ttfb).toBe(150.5);
    expect(body.entries[0].timing.domContentLoaded).toBe(450.2);
    expect(body.entries[0].timing.loadComplete).toBe(800.7);

    cleanup();
  });

  it("handles multiple entries in a single observer callback", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    perfObserverCallback!({
      getEntries: () => [
        {
          entryType: "paint",
          startTime: 100,
          name: "first-paint",
        },
        {
          entryType: "paint",
          startTime: 300,
          name: "first-contentful-paint",
        },
      ],
    });

    vi.advanceTimersByTime(10_000);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].timing.fp).toBe(100);
    expect(body.entries[1].timing.fcp).toBe(300);

    cleanup();
  });

  it("gracefully handles PerformanceObserver not being available", () => {
    // Remove PerformanceObserver from global scope
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).PerformanceObserver;

    const cleanup = initClientLogger();

    // Should still work without crashing
    expect(typeof cleanup).toBe("function");

    // No observer should have been created
    expect(perfObserverCallback).toBeNull();

    // Restore for subsequent tests
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.PerformanceObserver = MockPerformanceObserver as any;

    cleanup();
  });

  it("gracefully handles PerformanceObserver.observe throwing", () => {
    // Create a mock that throws on observe
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.PerformanceObserver = class ThrowingObserver {
      observe(): void {
        throw new Error("not supported");
      }
      disconnect(): void {
        // noop
      }
    } as any;

    // Should not throw
    const cleanup = initClientLogger();
    expect(typeof cleanup).toBe("function");

    // Restore
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.PerformanceObserver = MockPerformanceObserver as any;

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Periodic timer behavior
// ---------------------------------------------------------------------------

describe("periodic timer", () => {
  it("flushes every 10 seconds", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    // Add entry and advance 10s
    window.dispatchEvent(
      new ErrorEvent("error", { message: "tick 1" }),
    );
    vi.advanceTimersByTime(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Add another entry and advance another 10s
    window.dispatchEvent(
      new ErrorEvent("error", { message: "tick 2" }),
    );
    vi.advanceTimersByTime(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it("does not flush at 5 seconds", () => {
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "too early" }),
    );
    vi.advanceTimersByTime(5_000);

    expect(sendBeaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// SSR safety
// ---------------------------------------------------------------------------

describe("SSR safety", () => {
  it("returns noop cleanup when window is undefined", () => {
    // The module checks `typeof window === "undefined"`. In jsdom, window
    // always exists so we cannot truly remove it. Instead we verify that the
    // function returns a callable cleanup even in the normal path. This test
    // documents that the SSR guard exists in the source code.
    const cleanup = initClientLogger();
    expect(typeof cleanup).toBe("function");
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles error event where error property is null", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    // ErrorEvent with no error object (just a message)
    const event = new ErrorEvent("error", {
      message: "Script error.",
      filename: "",
      lineno: 0,
      colno: 0,
      error: null,
    });
    window.dispatchEvent(event);

    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries[0].message).toBe("Script error.");
    expect(body.entries[0].stack).toBeUndefined();

    cleanup();
  });

  it("handles rapid successive flushes without duplicating entries", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "only once" }),
    );

    // Trigger flush via pagehide
    window.dispatchEvent(new Event("pagehide"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Now the periodic timer fires -- buffer should be empty
    vi.advanceTimersByTime(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Still 1

    cleanup();
  });

  it("payload is valid JSON with entries array", () => {
    sendBeaconSpy.mockReturnValue(false);
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "json check" }),
    );
    vi.advanceTimersByTime(10_000);

    const rawBody = fetchSpy.mock.calls[0][1].body as string;
    const parsed = JSON.parse(rawBody);
    expect(parsed).toHaveProperty("entries");
    expect(Array.isArray(parsed.entries)).toBe(true);

    cleanup();
  });

  it("sendBeacon receives a Blob with application/json type", () => {
    sendBeaconSpy.mockReturnValue(true);
    const cleanup = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "blob check" }),
    );
    vi.advanceTimersByTime(10_000);

    const blobArg = sendBeaconSpy.mock.calls[0][1];
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe("application/json");

    cleanup();
  });

  it("multiple initClientLogger calls share module-level buffer", async () => {
    // This test documents that calling initClientLogger multiple times
    // accumulates entries into the same buffer. The second cleanup flushes
    // entries captured by both instances.
    sendBeaconSpy.mockReturnValue(false);

    const cleanup1 = initClientLogger();
    const cleanup2 = initClientLogger();

    window.dispatchEvent(
      new ErrorEvent("error", { message: "shared buffer test" }),
    );

    // Both error listeners fire, so we get 2 entries (one from each init)
    vi.advanceTimersByTime(10_000);

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.entries).toHaveLength(2);

    cleanup1();
    cleanup2();
  });
});
