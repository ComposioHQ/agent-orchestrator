import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { ensureServer } from "./lib/server.js";

const PORT = Number(process.env.AO_E2E_PORT ?? "3335");
const SESSION_ID = "backend-3";
const SESSION_PATH = `/sessions/${SESSION_ID}`;

const FIXTURE_SESSION = {
  id: SESSION_ID,
  projectId: "agent-orchestrator",
  status: "needs_input",
  activity: "waiting_input",
  runtimeName: "process",
  branch: "feat/harness-authority",
  issueId: "TKT-20260310-001",
  issueUrl: "https://linear.app/test/issue/TKT-20260310-001",
  issueLabel: "TKT-20260310-001",
  issueTitle: "Close harness runtime obedience gap",
  summary: "Waiting for operator review before merge.",
  summaryIsFallback: false,
  createdAt: "2026-03-10T10:00:00.000Z",
  lastActivityAt: "2026-03-10T10:05:00.000Z",
  pr: {
    number: 432,
    url: "https://github.com/acme/app/pull/432",
    title: "feat: close harness runtime obedience gap",
    owner: "acme",
    repo: "app",
    branch: "feat/harness-authority",
    baseBranch: "main",
    isDraft: false,
    state: "open",
    additions: 42,
    deletions: 7,
    ciStatus: "passing",
    ciChecks: [
      { name: "build", status: "passed" },
      { name: "test", status: "passed" },
    ],
    reviewDecision: "approved",
    mergeability: {
      mergeable: true,
      ciPassing: true,
      approved: true,
      noConflicts: true,
      blockers: [],
    },
    unresolvedThreads: 0,
    unresolvedComments: [],
  },
  metadata: {
    agent: "claude-code",
  },
  harness: {
    workId: "TKT-20260310-001",
    workState: {
      work_id: "TKT-20260310-001",
      work_status: "review",
      retry_count: 1,
      retry_budget: 3,
      active_session_id: SESSION_ID,
      updated_at: "2026-03-10T10:05:00.000Z",
    },
    reconciliation: {
      work_id: "TKT-20260310-001",
      next_action: "reconcile_session",
      reason: "runtime exited during verification",
      active_session_id: SESSION_ID,
      updated_at: "2026-03-10T10:05:00.000Z",
    },
    dispatchPlan: {
      work_id: "TKT-20260310-001",
      work_status: "review",
      next_action: "operator_review",
      priority: 92,
      reason: "human review required before merge",
    },
  },
};

async function main(): Promise<void> {
  const server = await ensureServer(PORT);
  const browser = await chromium.launch({ headless: true });

  try {
    await runSessionAuthorityFlow(browser, server.baseUrl);
    console.log("operator E2E passed");
  } finally {
    await browser.close();
    server.stop();
  }
}

async function runSessionAuthorityFlow(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  baseUrl: string,
): Promise<void> {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();

  let lastPostedMessage: string | null = null;

  await page.route(`**/api/sessions/${SESSION_ID}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(FIXTURE_SESSION),
    });
  });

  await page.route(`**/api/sessions/${SESSION_ID}/message`, async (route) => {
    const payload = route.request().postDataJSON() as { message?: string };
    lastPostedMessage = payload.message ?? null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  await page.goto(SESSION_PATH, { waitUntil: "networkidle" });
  await expectText(page, "Work Authority");
  await expectText(page, "TKT-20260310-001");
  await expectText(page, "runtime exited during verification");
  await expectText(page, "Quick Commands");

  await page.getByRole("button", { name: /Summarize State/i }).click();
  await page.waitForTimeout(150);

  assert.ok(lastPostedMessage, "expected quick command to post a message");
  assert.match(lastPostedMessage, /Summarize the current state/i);
  assert.match(lastPostedMessage, /confidence/i);

  await expectText(page, "sent");

  await context.close();
}

async function expectText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible" });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
