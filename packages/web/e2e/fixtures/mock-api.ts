import type { Page, Route } from "@playwright/test";
import type {
  DashboardSession,
  DashboardStats,
} from "../../src/lib/types.js";

/** Headers that prevent browser caching (important for polling tests) */
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

interface MockSessionsResponse {
  sessions: DashboardSession[];
  stats: DashboardStats;
}

/**
 * Set up route interception for all /api/* endpoints.
 *
 * Playwright's page.route() intercepts browser-level network requests.
 * This works for client-side fetches (session detail page, SSE polling)
 * but NOT for Next.js server-side rendering (which calls services directly).
 */
export async function mockAPI(
  page: Page,
  data: {
    sessions?: MockSessionsResponse;
    sessionById?: Record<string, DashboardSession>;
  },
): Promise<void> {
  // Mock GET /api/sessions
  if (data.sessions) {
    await page.route("**/api/sessions", async (route: Route) => {
      const url = new URL(route.request().url());
      // Only match the exact /api/sessions path (not /api/sessions/xxx)
      if (
        route.request().method() === "GET" &&
        url.pathname === "/api/sessions"
      ) {
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
          body: JSON.stringify(data.sessions),
        });
      } else {
        await route.continue();
      }
    });
  }

  // Mock GET /api/sessions/[id]
  if (data.sessionById) {
    for (const [id, session] of Object.entries(data.sessionById)) {
      await page.route(
        `**/api/sessions/${id}`,
        async (route: Route) => {
          const url = new URL(route.request().url());
          // Only match exact /api/sessions/<id> (not sub-paths like /send)
          if (
            route.request().method() === "GET" &&
            url.pathname === `/api/sessions/${id}`
          ) {
            await route.fulfill({
              status: 200,
              headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
              body: JSON.stringify(session),
            });
          } else {
            await route.continue();
          }
        },
      );
    }
  }

  // Mock POST endpoints to return success by default
  await page.route("**/api/sessions/*/send", async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/sessions/*/kill", async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/sessions/*/restore", async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/sessions/*/message", async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      body: JSON.stringify({ success: true }),
    });
  });

  await page.route("**/api/prs/*/merge", async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      body: JSON.stringify({ ok: true }),
    });
  });

  // Mock SSE events endpoint
  await page.route("**/api/events", async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
      body: `data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`,
    });
  });
}

/** Mock a single session endpoint by ID */
export async function mockSession(
  page: Page,
  id: string,
  session: DashboardSession,
): Promise<void> {
  await page.route(`**/api/sessions/${id}`, async (route: Route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      url.pathname === `/api/sessions/${id}`
    ) {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
        body: JSON.stringify(session),
      });
    } else {
      await route.continue();
    }
  });
}

/** Mock SSE endpoint to prevent polling errors */
export async function mockSSE(page: Page): Promise<void> {
  await page.route("**/api/events", async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
      body: `data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`,
    });
  });
}

/** Mock the sessions list endpoint (used by zone count fetches) */
export async function mockSessionsList(
  page: Page,
  sessions: DashboardSession[] = [],
): Promise<void> {
  await page.route("**/api/sessions", async (route: Route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      url.pathname === "/api/sessions"
    ) {
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
        body: JSON.stringify({
          sessions,
          stats: {
            totalSessions: sessions.length,
            workingSessions: sessions.filter((s) => s.activity === "active")
              .length,
            openPRs: sessions.filter((s) => s.pr?.state === "open").length,
            needsReview: 0,
          },
        }),
      });
    } else {
      await route.continue();
    }
  });
}
