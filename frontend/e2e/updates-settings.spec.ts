import { expect, test } from "@playwright/test";
import { installFakeBridge } from "./support/fake-bridge";

test("downloaded update keeps the full version readable and actions aligned", async ({ page }) => {
	await page.setViewportSize({ width: 1010, height: 700 });
	await page.emulateMedia({ colorScheme: "dark" });
	await installFakeBridge(page, {
		version: "0.12.7-nightly.202608240525",
		updateSettings: { enabled: true, channel: "nightly", nightlyAck: true, feature: null },
		updateStatus: {
			state: "downloaded",
			version: "0.12.8-nightly.202608241447",
			checkedAt: new Date("2026-08-24T17:11:00.000Z").getTime(),
		},
	});

	await page.goto("/#/settings");
	await page.getByRole("button", { name: "Updates" }).click();

	await expect(page.getByTestId("update-status-line")).toContainText("Downloaded. Restart to finish updating.");

	// The heading carries the base version; the full nightly stamp sits on its
	// own monospace line. As one heading it wrapped mid-token and swallowed the
	// row, and the primary action grew across it.
	const version = page.getByTestId("app-version");
	await expect(version).toHaveText("v0.12.7");
	await expect(version).toHaveAttribute("aria-label", "Current version - v0.12.7-nightly.202608240525");
	await expect(page.getByText("0.12.7-nightly.202608240525", { exact: true })).toBeVisible();

	await expect(page.getByRole("button", { name: "Restart & install" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Check for updates" })).toBeVisible();
	await expect(page.getByRole("switch", { name: "Automatic Updates" })).toBeChecked();
	await expect(page.getByRole("button", { name: "Updates channel" })).toContainText("Nightly");
	await expect(page.locator(".nightly-warning")).toBeVisible();

	const lineCount = await version.evaluate((element) => element.getClientRects().length);
	expect(lineCount).toBe(1);

	const restartBox = await page.getByRole("button", { name: "Restart & install" }).boundingBox();
	const checkBox = await page.getByRole("button", { name: "Check for updates" }).boundingBox();
	expect(restartBox).not.toBeNull();
	expect(checkBox).not.toBeNull();
	expect(Math.abs((restartBox?.height ?? 0) - (checkBox?.height ?? 0))).toBeLessThan(1);
	// The actions row must not overrun the version block.
	const versionBox = await version.boundingBox();
	expect(restartBox?.x ?? 0).toBeGreaterThan((versionBox?.x ?? 0) + (versionBox?.width ?? 0));
});
