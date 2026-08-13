import { expect, test } from "@playwright/test";
import { installFakeAgent } from "./support/fake-bridge";

test("renderer: sidebar visibility changes do not rerender the board @T0 @PERF", async ({ page }) => {
	await installFakeAgent(page, { workers: [{ id: "profiled", title: "Profiled worker" }] });
	await page.goto("/#/");
	await expect(page.getByTestId("board")).toBeVisible();

	await page.evaluate(() => window.__aoRenderProfile?.clear());
	await page.getByRole("button", { name: "Collapse sidebar" }).click();
	await expect(page.getByTestId("shell-content-row").getByRole("button", { name: "Expand sidebar" })).toBeVisible();

	await expect
		.poll(() => page.evaluate(() => window.__aoRenderProfile?.entries().map((entry) => entry.id) ?? []))
		.toContain("shell.sidebar");
	const committedSubtrees = await page.evaluate(() => window.__aoRenderProfile?.entries().map((entry) => entry.id) ?? []);

	expect(committedSubtrees).not.toContain("board");
	expect(committedSubtrees).not.toContain("shell.route");
});

test("renderer: command palette hover does not rerender persistent shell content @T0 @PERF", async ({ page }) => {
	await page.route("**/api/v1/agents", async (route) => {
		await route.fulfill({ contentType: "application/json", body: JSON.stringify({ agents: [] }) });
	});
	await installFakeAgent(page, { workers: [{ id: "profiled", title: "Profiled worker" }] });
	await page.goto("/#/");
	await expect(page.getByTestId("board")).toBeVisible();

	await page.keyboard.press("ControlOrMeta+k");
	await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
	const command = page.locator("[data-slot='command-item']").nth(5);
	await expect(command).toBeVisible();
	await page.waitForTimeout(250);

	await page.evaluate(() => window.__aoRenderProfile?.clear());
	await command.hover();

	await page.waitForTimeout(100);
	const committedSubtrees = await page.evaluate(() => window.__aoRenderProfile?.entries() ?? []);

	expect(committedSubtrees.map((entry) => entry.id)).not.toContain("shell.sidebar");
	expect(committedSubtrees.map((entry) => entry.id)).not.toContain("shell.route");
});
