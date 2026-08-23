import { expect, test } from "@playwright/test";
import { installFakeBridge } from "./support/fake-bridge";

const CURRENT_VERSION = "0.12.7-nightly.202608221348";
const AVAILABLE_VERSION = "0.12.7-nightly.202608231350";

test("automatic updates stay readable without asking for a manual download", async ({ page }) => {
	await page.setViewportSize({ width: 1496, height: 1096 });
	await installFakeBridge(page, {
		version: CURRENT_VERSION,
		updateSettings: { enabled: true, channel: "nightly", nightlyAck: true, feature: null },
		updateStatus: {
			state: "available",
			version: AVAILABLE_VERSION,
			checkedAt: Date.UTC(2026, 7, 23, 14, 23),
		},
	});

	await page.goto("/#/settings");
	await page.getByRole("button", { name: "Updates" }).click();

	const panel = page.locator(".update-status-panel");
	await expect(panel).toBeVisible();
	if (process.env.AO_UPDATE_EVIDENCE_PATH) {
		await panel.screenshot({ path: process.env.AO_UPDATE_EVIDENCE_PATH });
	}
	await expect(panel).toContainText(`v${AVAILABLE_VERSION}`);
	await expect(panel).toContainText("Downloads automatically");
	await expect(panel.getByRole("button", { name: /Update to/ })).toHaveCount(0);

	const geometry = await panel.evaluate((element) => {
		const status = element.querySelector<HTMLElement>("#update-status-line");
		const headline = status?.querySelector<HTMLElement>("p");
		const currentVersion = element.querySelector<HTMLElement>("[data-testid='app-version']");
		if (!status || !headline || !currentVersion) throw new Error("Update status geometry is unavailable");
		const lineCount = (node: HTMLElement) => Math.round(node.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(node).lineHeight));
		return {
			statusWidth: status.getBoundingClientRect().width,
			headlineLines: lineCount(headline),
			currentVersionLines: lineCount(currentVersion),
		};
	});

	expect(geometry.statusWidth).toBeGreaterThan(400);
	expect(geometry.headlineLines).toBeLessThanOrEqual(2);
	expect(geometry.currentVersionLines).toBeLessThanOrEqual(2);

});
