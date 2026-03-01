import { test, expect } from "@playwright/test";
import { makeSession, makePR } from "../fixtures/mock-data.js";
import { mockSession, mockSSE, mockSessionsList } from "../fixtures/mock-api.js";

test.describe("Session Detail Page", () => {
  test.beforeEach(async ({ page }) => {
    await mockSSE(page);
    await mockSessionsList(page);
  });

  test("shows session header with ID", async ({ page }) => {
    const session = makeSession({ id: "detail-1", activity: "active" });
    await mockSession(page, "detail-1", session);

    await page.goto("/sessions/detail-1");
    await expect(page.getByRole("heading", { name: "detail-1" })).toBeVisible();
  });

  test("shows activity badge", async ({ page }) => {
    const session = makeSession({ id: "detail-2", activity: "active" });
    await mockSession(page, "detail-2", session);

    await page.goto("/sessions/detail-2");
    // Activity badge renders as a capitalized label like "Active"
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
  });

  test("shows project pill", async ({ page }) => {
    const session = makeSession({ id: "detail-3", projectId: "my-app" });
    await mockSession(page, "detail-3", session);

    await page.goto("/sessions/detail-3");
    await expect(page.getByText("my-app").first()).toBeVisible();
  });

  test("shows branch pill", async ({ page }) => {
    const session = makeSession({ id: "detail-4", branch: "feat/auth" });
    await mockSession(page, "detail-4", session);

    await page.goto("/sessions/detail-4");
    await expect(page.getByText("feat/auth").first()).toBeVisible();
  });

  test("shows PR pill when session has PR", async ({ page }) => {
    const session = makeSession({
      id: "detail-5",
      pr: makePR({ number: 42 }),
    });
    await mockSession(page, "detail-5", session);

    await page.goto("/sessions/detail-5");
    await expect(page.getByText("PR #42").first()).toBeVisible();
  });

  test("shows issue label pill", async ({ page }) => {
    const session = makeSession({
      id: "detail-6",
      issueUrl: "https://linear.app/test/INT-100",
      issueLabel: "INT-100",
    });
    await mockSession(page, "detail-6", session);

    await page.goto("/sessions/detail-6");
    await expect(page.getByText("INT-100").first()).toBeVisible();
  });

  test("shows PR card with CI checks", async ({ page }) => {
    const pr = makePR({
      number: 42,
      title: "feat: health check",
      additions: 120,
      deletions: 30,
      ciChecks: [
        { name: "build", status: "passed" },
        { name: "test", status: "passed" },
        { name: "lint", status: "passed" },
      ],
    });
    const session = makeSession({ id: "detail-7", pr });
    await mockSession(page, "detail-7", session);

    await page.goto("/sessions/detail-7");
    await expect(page.getByText("feat: health check").first()).toBeVisible();
    await expect(page.getByText("Ready to merge").first()).toBeVisible();
  });

  test("shows blockers when PR is not ready", async ({ page }) => {
    const pr = makePR({
      number: 43,
      title: "fix: broken stuff",
      ciStatus: "failing",
      ciChecks: [{ name: "test", status: "failed" }],
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["CI checks failing", "Needs review"],
      },
      reviewDecision: "changes_requested",
    });
    const session = makeSession({ id: "detail-8", pr });
    await mockSession(page, "detail-8", session);

    await page.goto("/sessions/detail-8");
    // Should show blockers, not "Ready to merge"
    await expect(page.getByText("Ready to merge")).not.toBeVisible();
  });

  test("shows loading state initially", async ({ page }) => {
    // Delay the API response to catch loading state
    await page.route("**/api/sessions/slow-session", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/sessions/slow-session") {
        await new Promise((r) => setTimeout(r, 2000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(makeSession({ id: "slow-session" })),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/slow-session");
    await expect(page.getByText("Loading session")).toBeVisible();
  });

  test("shows error state on API failure", async ({ page }) => {
    await page.route("**/api/sessions/broken", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/sessions/broken") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Internal error" }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/broken");
    await expect(page.getByText("Failed to load session")).toBeVisible();
    await expect(
      page.locator("a", { hasText: "Back to dashboard" }),
    ).toBeVisible();
  });

  test("back link navigates to dashboard", async ({ page }) => {
    const session = makeSession({ id: "detail-nav" });
    await mockSession(page, "detail-nav", session);

    await page.goto("/sessions/detail-nav");
    await expect(page.getByRole("heading", { name: "detail-nav" })).toBeVisible();

    // Click the Orchestrator breadcrumb link
    await page.locator("a", { hasText: "Orchestrator" }).click();
    await expect(page).toHaveURL("/");
  });

  test("orchestrator session shows status strip", async ({ page }) => {
    const session = makeSession({
      id: "my-app-orchestrator",
      activity: "active",
    });
    await page.route("**/api/sessions/my-app-orchestrator", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        url.pathname === "/api/sessions/my-app-orchestrator"
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
    // Override the sessions list to provide zone count data
    await page.route("**/api/sessions", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        url.pathname === "/api/sessions"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sessions: [
              makeSession({ id: "worker-1" }),
              makeSession({ id: "worker-2" }),
            ],
            stats: {
              totalSessions: 2,
              workingSessions: 2,
              openPRs: 0,
              needsReview: 0,
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/sessions/my-app-orchestrator");
    await expect(page.getByRole("heading", { name: "my-app-orchestrator" })).toBeVisible();
  });
});
