/// <reference lib="webworker" />

const CACHE_NAME = "ao-v1";
const OFFLINE_URL = "/offline.html";

// Static assets to pre-cache
const PRECACHE_URLS = [OFFLINE_URL];

// Install — pre-cache offline page
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

// Activate — clean old caches
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

// Fetch — network-first for API/navigation, cache-first for static assets
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // Skip SSE/WebSocket endpoints
  if (url.pathname.startsWith("/api/events")) return;

  // API routes — network-first (fresh data)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then((cached) => cached || new Response("{}", { status: 503 })),
      ),
    );
    return;
  }

  // Static assets (JS, CSS, images, fonts) — cache-first
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.match(/\.(js|css|woff2?|svg|png|ico)$/)
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Navigation — network-first with offline fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL)),
    );
    return;
  }

  // Everything else — network with cache fallback
  event.respondWith(
    fetch(request).catch(() => caches.match(request)),
  );
});
