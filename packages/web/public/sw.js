/* global self, caches, fetch, URL, Response */
/// <reference lib="webworker" />

/**
 * Service Worker for Agent Orchestrator PWA.
 *
 * Strategy overview:
 *   SSE (/api/events)      → passthrough (not intercepted)
 *   API (/api/*)            → network-only, 503 JSON fallback when offline
 *   /_next/static/*         → cache-first (content-hashed, safe to cache forever)
 *   Navigation              → network-first, offline.html fallback
 *   Everything else         → network-first, no cache
 *
 * Cache versioning: bump CACHE_VERSION on deploy to purge stale entries.
 */

const CACHE_VERSION = 1;
const CACHE_NAME = `ao-v${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

// ── Install ────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([OFFLINE_URL])),
  );
  self.skipWaiting();
});

// ── Activate — purge caches from older versions ────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

// ── Fetch ──────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET — let POST/PUT/DELETE etc. pass through
  if (request.method !== "GET") return;

  // SSE endpoint — let browser handle natively (EventSource manages reconnect)
  if (url.pathname.startsWith("/api/events")) return;

  // API routes — network-only with offline JSON fallback
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ error: "offline" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    return;
  }

  // Next.js content-hashed assets — cache-first (hash in URL guarantees freshness)
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request)
            .then((response) => {
              if (response.ok) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((c) => c.put(request, clone));
              }
              return response;
            })
            .catch(
              () => new Response("", { status: 504, statusText: "Offline" }),
            ),
      ),
    );
    return;
  }

  // Navigation — network-first with offline.html fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .match(OFFLINE_URL)
          .then(
            (cached) =>
              cached ||
              new Response("Offline", {
                status: 503,
                headers: { "Content-Type": "text/html" },
              }),
          ),
      ),
    );
    return;
  }

  // Everything else — network-only (non-hashed assets like /public/ files
  // should not be cached because we can't invalidate them)
  event.respondWith(
    fetch(request).catch(
      () => new Response("", { status: 504, statusText: "Offline" }),
    ),
  );
});
