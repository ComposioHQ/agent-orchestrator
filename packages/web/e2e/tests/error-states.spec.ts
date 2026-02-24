import { test, expect } from "@playwright/test";
import { mockSSE, mockSessionsList } from "../fixtures/mock-api.js";

test.describe("Error States", () => {
  test.beforeEach(async ({ page }) => {
    await mockSSE(page);
    await mockSessionsList(page);
  });

  test("session detail shows not-found for 404 API response", async ({
    page,
  }) => {
    await page.route("**/api/sessions/missing", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/sessions/missing") {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Session not found" }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/missing");
    await expect(page.locator("text=Session not found")).toBeVisible();
    await expect(
      page.locator("a", { hasText: "Back to dashboard" }),
    ).toBeVisible();
  });

  test("session detail shows error for 500 API response", async ({ page }) => {
    await page.route("**/api/sessions/errored", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/sessions/errored") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Server error" }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/errored");
    await expect(page.locator("text=Failed to load session")).toBeVisible();
  });

  test("session detail shows error for network failure", async ({ page }) => {
    await page.route("**/api/sessions/network-fail", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/sessions/network-fail") {
        await route.abort("connectionrefused");
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/network-fail");
    await expect(page.locator("text=Failed to load session")).toBeVisible();
  });

  test("dashboard gracefully handles missing config", async ({ page }) => {
    // Dashboard page.tsx wraps everything in try/catch
    // Without backend services, it shows empty state
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Orchestrator");
  });

  test("non-existent page returns 404 status", async ({ page }) => {
    const response = await page.goto("/does-not-exist-page");
    expect(response?.status()).toBe(404);
  });
});
