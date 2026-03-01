import { test, expect } from "@playwright/test";
import { makeSession, makePR } from "../fixtures/mock-data.js";
import { mockSSE, mockSessionsList } from "../fixtures/mock-api.js";

test.describe("API Integration via UI Actions", () => {
  test.beforeEach(async ({ page }) => {
    await mockSSE(page);
    await mockSessionsList(page);
  });

  test("session detail fetches from /api/sessions/:id", async ({ page }) => {
    let fetchCalled = false;
    const session = makeSession({ id: "api-fetch" });

    await page.route("**/api/sessions/api-fetch", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        url.pathname === "/api/sessions/api-fetch"
      ) {
        fetchCalled = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(session),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/api-fetch");
    await expect(page.getByRole("heading", { name: "api-fetch" })).toBeVisible();
    expect(fetchCalled).toBe(true);
  });

  test("Ask Agent to Fix sends POST to /api/sessions/:id/message", async ({
    page,
  }) => {
    const pr = makePR({
      number: 44,
      unresolvedThreads: 1,
      unresolvedComments: [
        {
          url: "https://github.com/c/1",
          path: "src/auth.ts",
          author: "alice",
          body: "Fix null check",
        },
      ],
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ id: "api-fix", activity: "idle", pr });

    await page.route("**/api/sessions/api-fix", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        url.pathname === "/api/sessions/api-fix"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(session),
        });
      } else {
        await route.continue();
      }
    });

    let messageSent = false;
    await page.route("**/api/sessions/api-fix/message", async (route) => {
      messageSent = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto("/sessions/api-fix");
    // Wait for unresolved comments section to appear
    const unresolvedHeading = page.getByText("Unresolved", { exact: false });
    await expect(unresolvedHeading.first()).toBeVisible();

    // Click "Ask Agent to Fix" button and verify the POST fires
    const fixButton = page.getByRole("button", { name: /Ask Agent to Fix/i });
    await expect(fixButton.first()).toBeVisible();
    await fixButton.first().click();
    // Wait for the message POST to be intercepted by our route handler
    await expect
      .poll(() => messageSent, { timeout: 5000 })
      .toBe(true);
  });

  test("session detail page uses polling interval", async ({ page }) => {
    // Verify polling by detecting a second GET after the page has loaded
    const session = makeSession({ id: "api-poll", activity: "active" });

    await page.route("**/api/sessions/api-poll", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        url.pathname === "/api/sessions/api-poll"
      ) {
        await route.fulfill({
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
          body: JSON.stringify(session),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/api-poll");
    await expect(page.getByRole("heading", { name: "api-poll" })).toBeVisible();

    // After initial load, wait for the next polling request (deterministic, no arbitrary timeout)
    const pollingRequest = await page.waitForRequest(
      (req) =>
        req.url().includes("/api/sessions/api-poll") &&
        req.method() === "GET",
      { timeout: 10_000 },
    );
    expect(pollingRequest.url()).toContain("/api/sessions/api-poll");
  });

  test("kill action endpoint exists and returns JSON", async ({ page }) => {
    const response = await page.request.post(
      "http://127.0.0.1:3333/api/sessions/api-kill/kill",
    );
    // Verify route exists (returns JSON, not Next.js HTML 404) and responds
    const contentType = response.headers()["content-type"] ?? "";
    expect(contentType).toContain("application/json");
    // Route should return a parseable JSON body
    const body = await response.json();
    expect(typeof body).toBe("object");
  });

  test("merge PR endpoint exists and returns JSON", async ({ page }) => {
    const response = await page.request.post(
      "http://127.0.0.1:3333/api/prs/999/merge",
    );
    // Verify route exists (returns JSON, not Next.js HTML 404) and responds
    const contentType = response.headers()["content-type"] ?? "";
    expect(contentType).toContain("application/json");
    // Route should return a parseable JSON body
    const body = await response.json();
    expect(typeof body).toBe("object");
  });
});
