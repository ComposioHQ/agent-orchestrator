import { expect, test, type Locator, type Page } from "@playwright/test";
import { installFakeBridge } from "./support/fake-bridge";

const CURRENT_VERSION = "0.12.7-nightly.202608221348";
const AVAILABLE_VERSION = "0.12.7-nightly.202608231350";
const CHECKED_AT = Date.UTC(2026, 7, 23, 14, 23);

async function openUpdates(page: Page) {
	await page.addInitScript(() => window.localStorage.setItem("ao.theme", "dark"));
	await page.goto("/#/settings");
	await page.getByRole("button", { name: "Updates" }).click();
	const panel = page.locator(".update-status-panel");
	await expect(panel).toBeVisible();
	return panel;
}

async function captureEvidence(panel: Locator, name: string) {
	if (process.env.AO_UPDATE_EVIDENCE_DIR) {
		await panel.evaluate(async (element) => {
			await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
		});
		await panel.screenshot({ path: `${process.env.AO_UPDATE_EVIDENCE_DIR}/${name}.png` });
	}
}

test("automatic updates stay readable without asking for a manual download", async ({ page }) => {
	await page.setViewportSize({ width: 1496, height: 1096 });
	await installFakeBridge(page, {
		version: CURRENT_VERSION,
		updateSettings: { enabled: true, channel: "nightly", nightlyAck: true, feature: null },
		updateStatus: {
			state: "available",
			version: AVAILABLE_VERSION,
			checkedAt: CHECKED_AT,
		},
	});

	const panel = await openUpdates(page);
	await captureEvidence(panel, "available");
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

test("downloaded updates present one clear restart action and structured metadata", async ({ page }) => {
	await page.setViewportSize({ width: 1496, height: 1096 });
	await installFakeBridge(page, {
		version: CURRENT_VERSION,
		updateSettings: { enabled: true, channel: "nightly", nightlyAck: true, feature: null },
		updateStatus: {
			state: "downloaded",
			version: AVAILABLE_VERSION,
			checkedAt: CHECKED_AT,
			stagedAt: CHECKED_AT,
		},
	});

	const panel = await openUpdates(page);
	await captureEvidence(panel, "downloaded");
	await expect(panel.getByRole("status")).toContainText("Update ready");
	await expect(panel.getByText("Current version", { exact: true })).toBeVisible();
	await expect(panel.getByText(`v${CURRENT_VERSION}`, { exact: true })).toBeVisible();
	await expect(panel.getByText("Update version", { exact: true })).toBeVisible();
	await expect(panel.getByText(`v${AVAILABLE_VERSION}`, { exact: true })).toBeVisible();
	await expect(panel.getByText("Last checked", { exact: true })).toHaveCount(0);
	await expect(panel.locator(".size-0\\.5.rounded-full")).toHaveCount(0);
	await expect(panel.getByRole("button", { name: "Restart & install" })).toBeVisible();
	await expect(panel.getByRole("button", { name: "Check for updates" })).toHaveCount(0);
});

test("latest-version state keeps metadata aligned without decorative separators", async ({ page }) => {
	await page.setViewportSize({ width: 1496, height: 1096 });
	await installFakeBridge(page, {
		version: AVAILABLE_VERSION,
		updateSettings: { enabled: true, channel: "nightly", nightlyAck: true, feature: null },
		updateStatus: { state: "not-available", checkedAt: CHECKED_AT },
	});

	const panel = await openUpdates(page);
	await captureEvidence(panel, "latest");
	await expect(panel.getByRole("status")).toContainText("You're on the latest version.");
	await expect(panel.getByText("Current version", { exact: true })).toBeVisible();
	await expect(panel.getByText(`v${AVAILABLE_VERSION}`, { exact: true })).toBeVisible();
	await expect(panel.getByText("Last checked", { exact: true })).toBeVisible();
	await expect(panel.locator(".size-0\\.5.rounded-full")).toHaveCount(0);
	await expect(panel.getByRole("button", { name: "Check for updates" })).toBeVisible();
});
