import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { ensureServer } from "./lib/server.js";

const PORT = Number(process.env.AO_E2E_PORT ?? "3001");

async function main(): Promise<void> {
  const server = await ensureServer(PORT);
  const browser = await chromium.launch({ headless: true });

  try {
    await runDashboardCommandFlow(browser, server.baseUrl);
    console.log("dashboard E2E passed");
  } finally {
    await browser.close();
    server.stop();
  }
}

async function runDashboardCommandFlow(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  baseUrl: string,
): Promise<void> {
  const context = await browser.newContext({ baseURL: baseUrl });
  const page = await context.newPage();

  let spawnedPayload: { projectId?: string; issueId?: string } | null = null;
  let resolveSpawnSeen: (() => void) | null = null;
  const spawnSeen = new Promise<void>((resolve) => {
    resolveSpawnSeen = resolve;
  });

  await page.route("**/api/spawn", async (route) => {
    const payload = route.request().postDataJSON() as { projectId?: string; issueId?: string };
    spawnedPayload = payload;
    resolveSpawnSeen?.();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: "e2e-session-1",
          projectId: payload.projectId ?? "agent-orchestrator",
        },
      }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectText(page, "Control Inbox");
  await page.waitForTimeout(2000);

  const input = page.getByPlaceholder("next / dispatch 123 / explain TKT-... / act TKT-... send");
  await input.fill("dispatch ISSUE-777");
  await page.getByRole("button", { name: /run command/i }).click();
  await Promise.race([
    spawnSeen,
    page.waitForTimeout(5000).then(() => {
      throw new Error("spawn request was not issued");
    }),
  ]);
  await page.waitForTimeout(1000);
  const bodyText = await page.locator("body").innerText();
  const statusLine =
    bodyText
      .split(/\r?\n/)
      .find((line) => line.includes("state=")) ?? "";

  assert.ok(spawnedPayload, "dispatch command should call /api/spawn");
  assert.equal(spawnedPayload?.issueId, "ISSUE-777");
  assert.ok(spawnedPayload?.projectId, "dispatch should send projectId");
  assert.match(statusLine, /state=spawned/i, "dashboard should render spawned status after dispatch");

  await context.close();
}

async function expectText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible" });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
