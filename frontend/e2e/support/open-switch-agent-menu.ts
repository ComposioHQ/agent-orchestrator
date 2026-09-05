import { expect, type Page } from "@playwright/test";

export async function openSwitchAgentDialog(page: Page) {
	await page.getByRole("button", { name: "Session actions", exact: true }).click();
	const menu = page.getByRole("menu");
	const switchAgent = page.getByRole("menuitem", { name: "Switch agent", exact: true });
	await expect(switchAgent).toBeVisible();
	await switchAgent.click();
	await expect(menu).toBeHidden();
	const dialog = page.getByRole("dialog", { name: "Switch agent" });
	await expect(dialog).toBeVisible();
	await page.waitForTimeout(500);
	await expect(dialog).toBeVisible();
	await expect
		.poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
		.toBe(true);
	return dialog;
}
