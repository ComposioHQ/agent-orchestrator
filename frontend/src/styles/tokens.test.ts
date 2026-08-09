import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
const rendererStyles = readFileSync(resolve(process.cwd(), "src/renderer/styles.css"), "utf8");

describe("workspace chrome tokens", () => {
	it("keeps the shared primary topbar at 36px", () => {
		expect(tokens).toMatch(/--size-topbar-primary:\s*36px;/);
		expect(rendererStyles).toMatch(
			/\.center-panel-shell--mac \.center-panel-titlebar\s*{[^}]*height:\s*var\(--size-toolbar\);[^}]*min-height:\s*var\(--size-toolbar\);/s,
		);
	});

	it("keeps terminal-card agent icons at 11px", () => {
		expect(tokens).toMatch(/--size-terminal-agent-icon:\s*11px;/);
	});
});
