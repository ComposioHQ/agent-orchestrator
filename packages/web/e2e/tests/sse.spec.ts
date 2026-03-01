import { test, expect } from "@playwright/test";
import { makeSession } from "../fixtures/mock-data.js";
import { mockSession, mockSessionsList } from "../fixtures/mock-api.js";

test.describe("Real-time Updates", () => {
  test("document title updates with session data", async ({ page }) => {
    const session = makeSession({
      id: "title-test",
      activity: "active",
      branch: "feat/auth",
    });

    await page.route("**/api/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: `data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`,
      });
    });
    await mockSessionsList(page);
    await mockSession(page, "title-test", session);

    await page.goto("/sessions/title-test");
    // Wait for title to update with session data
    await page.waitForFunction(
      () => document.title.includes("title-test"),
      { timeout: 10_000 },
    );
    const title = await page.title();
    expect(title).toContain("title-test");
  });

  test("session shows fresh data from server", async ({ page }) => {
    // Verify the page fetches and displays session data from the API
    const session = makeSession({
      id: "fresh-data",
      activity: "active",
      summary: "Fresh from API",
      branch: "feat/fresh",
    });

    await page.route("**/api/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: `data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`,
      });
    });
    await mockSessionsList(page);
    await mockSession(page, "fresh-data", session);

    await page.goto("/sessions/fresh-data");
    await expect(page.getByRole("heading", { name: "fresh-data" })).toBeVisible();
    await expect(page.getByText("feat/fresh").first()).toBeVisible();
  });

  test("SSE endpoint responds with event-stream content type", async ({ page }) => {
    // Navigate first so relative URLs work, then use fetch() with AbortController
    // to check headers without waiting for the SSE stream to complete
    await page.goto("/");
    const contentType = await page.evaluate(async () => {
      const controller = new AbortController();
      const res = await fetch("/api/events", { signal: controller.signal });
      const ct = res.headers.get("content-type") ?? "";
      controller.abort();
      return ct;
    });
    expect(contentType).toContain("text/event-stream");
  });
});
