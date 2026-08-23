import { expect, test, type Locator, type Page } from "@playwright/test";

// Regression for #4268. PR #3508 put `user-select: none` on <body> to stop drags
// from painting a highlight over sidebar/board chrome. `user-select` inherits, so
// it also killed selection on every content surface: session details, status
// text, error copy, PR metadata — nothing outside inputs and the terminal could
// be selected or copied. These cases pin both halves of the contract: readable
// content selects, and the chrome the pointer acts on still does not.

/** Drag across an element the way a user would when selecting its text. */
async function dragSelect(page: Page, locator: Locator): Promise<void> {
	await locator.scrollIntoViewIfNeeded();
	const box = await locator.boundingBox();
	if (!box) throw new Error("target has no layout box");
	await page.mouse.move(box.x + 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 12 });
	await page.mouse.up();
}

async function selectedText(page: Page): Promise<string> {
	return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function clearSelection(page: Page): Promise<void> {
	await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

function userSelectOf(locator: Locator): Promise<string> {
	return locator.evaluate((el) => getComputedStyle(el).userSelect);
}

test("readable content is selectable and copyable, chrome is not", async ({ page }) => {
	await page.goto("/");

	// The root default is what #3508 inverted. It is back to the initial value,
	// so the assertion is "not switched off" rather than a specific keyword.
	expect(await page.evaluate(() => getComputedStyle(document.body).userSelect)).not.toBe("none");

	// A board card is a click surface: dragging it must open nothing and select
	// nothing, so its text stays out of reach even though the page is selectable.
	const card = page.locator('[data-testid="board-session-card"]').first();
	await expect(card).toBeVisible();
	expect(await userSelectOf(card)).toBe("none");
	await dragSelect(page, card);
	expect(await selectedText(page)).toBe("");
	await expect(page).toHaveURL(/#\/?$|projects/);

	// Open a session so the inspector rail — the surface the report named — mounts.
	await clearSelection(page);
	await card.click();
	const inspector = page.locator("#inspector");
	await expect(inspector).toBeVisible();

	// Inspector body copy is content: a drag selects it and Copy puts it on the
	// clipboard. This is the case that was impossible before the fix.
	const section = inspector.locator('[data-testid="inspector-section"]').first();
	await expect(section).toBeVisible();
	expect(await userSelectOf(section)).not.toBe("none");

	// Drag a single line of body copy — the PR section's status line — rather than
	// the whole section, so the gesture stays on text instead of crossing rows.
	const line = section.locator("p").first();
	await expect(line).toBeVisible();
	await dragSelect(page, line);
	const selection = await selectedText(page);
	expect(selection.trim()).not.toBe("");
	// The drag must not have activated the section it crossed.
	await expect(inspector).toBeVisible();

	// And the selection reaches the clipboard over the ordinary Copy shortcut.
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
	const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
	expect(clipboard.trim()).toBe(selection.trim());
});

test("controls and drag surfaces stay unselectable", async ({ page }) => {
	await page.goto("/");
	const card = page.locator('[data-testid="board-session-card"]').first();
	await expect(card).toBeVisible();
	await card.click();
	await expect(page.locator("#inspector")).toBeVisible();

	// Buttons: a drag across a control must never leave text selected behind it.
	const button = page.getByRole("button").first();
	await expect(button).toBeAttached();
	expect(await userSelectOf(button)).toBe("none");

	// The sidebar rows #3508 was actually filed about.
	const sidebarRow = page.locator('[data-sidebar="menu-button"]').first();
	if ((await sidebarRow.count()) > 0) {
		expect(await userSelectOf(sidebarRow)).toBe("none");
	}

	// The inspector/sidebar resize handles are pointer-drag surfaces.
	const resizeHandle = page.locator('[data-slot="resize-handle"]').first();
	if ((await resizeHandle.count()) > 0) {
		expect(await userSelectOf(resizeHandle)).toBe("none");
	}
});

test("the terminal keeps its own selection model", async ({ page }) => {
	await page.goto("/");
	const card = page.locator('[data-testid="board-session-card"]').first();
	await expect(card).toBeVisible();
	await card.click();

	// xterm.css sets `.xterm { user-select: none }` itself and drives selection
	// through its own layer, so the body default must not leak in and change it.
	const xterm = page.locator(".xterm").first();
	if ((await xterm.count()) > 0) {
		await expect(xterm).toBeVisible();
		expect(await userSelectOf(xterm)).toBe("none");
	}
});
