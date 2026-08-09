import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

describe("workspace chrome tokens", () => {
	it("keeps the shared primary topbar at 36px", () => {
		expect(tokens).toMatch(/--size-topbar-primary:\s*36px;/);
	});
});
