import type { Page, Route } from "@playwright/test";
import type { DashboardSession } from "../../src/lib/types.js";

/** Headers that prevent browser caching (important for polling tests) */
const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

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
