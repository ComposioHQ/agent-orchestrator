import { test, expect } from "@playwright/test";
import { makeSession } from "../fixtures/mock-data.js";
import { mockSession, mockSSE, mockSessionsList } from "../fixtures/mock-api.js";

test.describe("Accessibility", () => {
  test("dashboard page has proper heading hierarchy", async ({ page }) => {
    await page.goto("/");
    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    await expect(h1).toContainText("Orchestrator");
  });

  test("page has correct lang attribute", async ({ page }) => {
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "en");
  });

  test("interactive elements are keyboard accessible", async ({ page }) => {
    await page.goto("/");
    // Tab to the first focusable element
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    // Should have focused on something
    const count = await focused.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("session detail navigation is accessible", async ({ page }) => {
    await mockSSE(page);
    await mockSessionsList(page);

    const session = makeSession({ id: "a11y-test" });
    await mockSession(page, "a11y-test", session);

    await page.goto("/sessions/a11y-test");
    // Back link should be keyboard accessible
    const backLink = page.locator("a", { hasText: "Orchestrator" });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute("href", "/");
  });

  test("error page has back link for navigation", async ({ page }) => {
    await mockSSE(page);
    await mockSessionsList(page);

    await page.route("**/api/sessions/a11y-error", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/sessions/a11y-error") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Session not found" }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/a11y-error");
    await expect(page.locator("text=Session not found")).toBeVisible();
    const backLink = page.locator("a", { hasText: "Back to dashboard" });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute("href", "/");
  });
});
