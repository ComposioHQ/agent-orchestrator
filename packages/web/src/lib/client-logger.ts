/**
 * Browser-side error and performance capture.
 *
 * Captures:
 * - window.onerror / unhandledrejection — JS runtime errors
 * - PerformanceObserver — LCP, FCP, TTFB navigation timing
 * - Fetch timing — API call durations from the browser side
 *
 * Batches entries and POSTs to /api/client-logs every 10 seconds
 * (or on page unload via navigator.sendBeacon).
 */

interface ClientLogEntry {
  level: "info" | "warn" | "error";
  message: string;
  url?: string;
  stack?: string;
  timing?: Record<string, number>;
}

let buffer: ClientLogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function addEntry(entry: ClientLogEntry): void {
  buffer.push(entry);
}

function flush(): void {
  if (buffer.length === 0) return;

  const entries = buffer;
  buffer = [];

  // Try sendBeacon first (works during unload), fall back to fetch
  const payload = JSON.stringify({ entries });
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    const sent = navigator.sendBeacon("/api/client-logs", new Blob([payload], { type: "application/json" }));
    if (sent) return;
  }

  // Fallback: fire-and-forget fetch
  fetch("/api/client-logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // best effort
  });
}

export function initClientLogger(): () => void {
  if (typeof window === "undefined") return () => {};

  // Capture JS errors
  const onError = (event: ErrorEvent): void => {
    addEntry({
      level: "error",
      message: event.message || "Unknown error",
      url: event.filename,
      stack: event.error?.stack,
    });
  };
  window.addEventListener("error", onError);

  // Capture unhandled promise rejections
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason;
    addEntry({
      level: "error",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };
  window.addEventListener("unhandledrejection", onRejection);

  // Performance observer for web vitals
  let perfObserver: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== "undefined") {
    try {
      perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === "largest-contentful-paint") {
            addEntry({
              level: "info",
              message: `LCP: ${Math.round(entry.startTime)}ms`,
              timing: { lcp: entry.startTime },
            });
          } else if (entry.entryType === "paint") {
            addEntry({
              level: "info",
              message: `${entry.name}: ${Math.round(entry.startTime)}ms`,
              timing: { [entry.name === "first-contentful-paint" ? "fcp" : "fp"]: entry.startTime },
            });
          } else if (entry.entryType === "navigation") {
            const nav = entry as PerformanceNavigationTiming;
            addEntry({
              level: "info",
              message: `Navigation: TTFB ${Math.round(nav.responseStart)}ms, DOM ${Math.round(nav.domContentLoadedEventEnd)}ms`,
              timing: {
                ttfb: nav.responseStart,
                domContentLoaded: nav.domContentLoadedEventEnd,
                loadComplete: nav.loadEventEnd,
              },
            });
          }
        }
      });
      perfObserver.observe({ type: "largest-contentful-paint", buffered: true });
      perfObserver.observe({ type: "paint", buffered: true });
      perfObserver.observe({ type: "navigation", buffered: true });
    } catch {
      // PerformanceObserver not supported for these types
    }
  }

  // Flush periodically
  flushTimer = setInterval(flush, 10_000);

  // Flush on page hide / visibility change
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") flush();
  };
  const onUnload = (): void => flush();
  window.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onUnload);

  // Return cleanup function
  return () => {
    flush();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onUnload);
    if (flushTimer) clearInterval(flushTimer);
    if (perfObserver) perfObserver.disconnect();
  };
}
