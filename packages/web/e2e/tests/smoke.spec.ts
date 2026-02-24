import { test, expect } from "@playwright/test";
import { makeSession } from "../fixtures/mock-data.js";
import { mockSession, mockSSE, mockSessionsList } from "../fixtures/mock-api.js";

test.describe("Smoke Tests", () => {
  test("dashboard page loads without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Orchestrator");
    expect(errors).toHaveLength(0);
  });

  test("dashboard shows empty state when no sessions", async ({ page }) => {
    await page.goto("/");
    // StatusLine renders "no sessions" when totalSessions === 0
    await expect(page.locator("text=no sessions")).toBeVisible();
  });

  test("session detail page loads for valid session", async ({ page }) => {
    const session = makeSession({ id: "smoke-1", summary: "Smoke test session" });
    await mockSession(page, "smoke-1", session);
    await mockSSE(page);
    await mockSessionsList(page);

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/sessions/smoke-1");
    await expect(page.getByRole("heading", { name: "smoke-1" })).toBeVisible();
    expect(errors).toHaveLength(0);
  });

  test("session detail shows not-found for missing session", async ({ page }) => {
    await page.route("**/api/sessions/nonexistent", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/sessions/nonexistent") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Session not found" }),
        });
      } else {
        await route.continue();
      }
    });
    await mockSSE(page);
    await mockSessionsList(page);

    await page.goto("/sessions/nonexistent");
    await expect(page.locator("text=Session not found")).toBeVisible();
  });

  test("non-existent route returns 404", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist");
    expect(response?.status()).toBe(404);
  });
});
