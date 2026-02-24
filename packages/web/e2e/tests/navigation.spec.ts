import { test, expect } from "@playwright/test";
import { makeSession } from "../fixtures/mock-data.js";
import { mockSession, mockSSE, mockSessionsList } from "../fixtures/mock-api.js";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockSSE(page);
    await mockSessionsList(page);
  });

  test("can navigate to session detail page", async ({ page }) => {
    const session = makeSession({ id: "nav-test" });
    await mockSession(page, "nav-test", session);

    await page.goto("/sessions/nav-test");
    await expect(page).toHaveURL("/sessions/nav-test");
    await expect(page.getByRole("heading", { name: "nav-test" })).toBeVisible();
  });

  test("session detail back link navigates to dashboard", async ({ page }) => {
    const session = makeSession({ id: "nav-back" });
    await mockSession(page, "nav-back", session);

    await page.goto("/sessions/nav-back");
    await expect(page.getByRole("heading", { name: "nav-back" })).toBeVisible();

    await page.locator("a", { hasText: "Orchestrator" }).click();
    await expect(page).toHaveURL("/");
  });

  test("browser back/forward works between pages", async ({ page }) => {
    const session = makeSession({ id: "history-test" });
    await mockSession(page, "history-test", session);

    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Orchestrator");

    await page.goto("/sessions/history-test");
    await expect(page.getByRole("heading", { name: "history-test" })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL("/");

    await page.goForward();
    await expect(page).toHaveURL("/sessions/history-test");
  });

  test("404 page shows helpful message", async ({ page }) => {
    await page.route("**/api/sessions/does-not-exist", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/sessions/does-not-exist") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Session not found" }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/does-not-exist");
    await expect(page.getByText("Session not found")).toBeVisible();
    await expect(
      page.locator("a", { hasText: "Back to dashboard" }),
    ).toBeVisible();
  });
});
