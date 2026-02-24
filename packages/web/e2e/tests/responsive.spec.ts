import { test, expect } from "@playwright/test";
import { makeSession, makePR } from "../fixtures/mock-data.js";
import { mockSession, mockSSE, mockSessionsList } from "../fixtures/mock-api.js";

test.describe("Responsive Layout", () => {
  test("dashboard renders correctly on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    const h1 = page.locator("h1");
    await expect(h1).toContainText("Orchestrator");
    await expect(h1).toBeInViewport();
  });

  test("dashboard renders correctly on tablet", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Orchestrator");
  });

  test("dashboard renders correctly on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("Orchestrator");
  });

  test("session detail page is usable on mobile", async ({ page }) => {
    await mockSSE(page);
    await mockSessionsList(page);
    await page.setViewportSize({ width: 375, height: 812 });

    const session = makeSession({
      id: "mobile-test",
      pr: makePR({ number: 42, title: "feat: responsive test" }),
    });
    await mockSession(page, "mobile-test", session);

    await page.goto("/sessions/mobile-test");
    await expect(page.getByRole("heading", { name: "mobile-test" })).toBeVisible();
    // Navigation should be accessible
    await expect(
      page.locator("a", { hasText: "Orchestrator" }),
    ).toBeVisible();
    // PR info should be visible
    await expect(page.getByText("PR #42").first()).toBeVisible();
  });

  test("page does not have horizontal overflow on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");

    // Check that body width does not exceed viewport
    const overflowing = await page.evaluate(() => {
      return (
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth
      );
    });
    expect(overflowing).toBe(false);
  });
});
