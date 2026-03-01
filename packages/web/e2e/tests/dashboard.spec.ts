import { test, expect } from "@playwright/test";

test.describe("Dashboard", () => {
  test("renders Orchestrator heading", async ({ page }) => {
    await page.goto("/");
    const h1 = page.locator("h1");
    await expect(h1).toContainText("Orchestrator");
  });

  test("shows 'no sessions' in status line when empty", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=no sessions")).toBeVisible();
  });

  test("does not show kanban zones when no sessions", async ({ page }) => {
    await page.goto("/");
    // Kanban zone labels should not be present
    await expect(page.locator("text=Working")).not.toBeVisible();
    await expect(page.locator("text=Pending")).not.toBeVisible();
    await expect(page.locator("text=Merge")).not.toBeVisible();
  });

  test("does not show PR table when no sessions", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Pull Requests")).not.toBeVisible();
  });

  test("does not show orchestrator button when no orchestrator session", async ({
    page,
  }) => {
    await page.goto("/");
    // orchestrator button only renders when orchestratorId is set
    await expect(
      page.locator("a.orchestrator-btn"),
    ).not.toBeVisible();
  });

  test("rate limit banner is not shown by default", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.locator("text=GitHub API rate limited"),
    ).not.toBeVisible();
  });

  test("page has correct title", async ({ page }) => {
    await page.goto("/");
    const title = await page.title();
    expect(title).toContain("ao");
  });
});
