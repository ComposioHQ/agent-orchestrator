import { describe, expect, it } from "vitest";
import { isCommandPaletteEnabled, isNightlyBuild, parseNightlyVersion } from "./build-channel";

describe("isNightlyBuild", () => {
	it("detects -nightly. stamps and rejects everything else", () => {
		expect(isNightlyBuild("0.10.4-nightly.202607071200+abc123")).toBe(true);
		expect(isNightlyBuild("0.10.3")).toBe(false);
		expect(isNightlyBuild(undefined)).toBe(false);
		expect(isNightlyBuild("0.0.0-preview")).toBe(false);
		expect(isNightlyBuild("0.0.0-test")).toBe(false);
	});
});

describe("isCommandPaletteEnabled", () => {
	it("is on in dev or nightly, off otherwise", () => {
		expect(isCommandPaletteEnabled("0.10.3", true)).toBe(true);
		expect(isCommandPaletteEnabled(undefined, true)).toBe(true);
		expect(isCommandPaletteEnabled("0.10.4-nightly.202607071200+abc123", false)).toBe(true);
		expect(isCommandPaletteEnabled("0.10.3", false)).toBe(false);
		expect(isCommandPaletteEnabled(undefined, false)).toBe(false);
	});
});

describe("parseNightlyVersion", () => {
	it("splits a nightly stamp into base version and build date", () => {
		const parsed = parseNightlyVersion("0.12.11-nightly.202609021713");
		expect(parsed?.base).toBe("0.12.11");
		expect(parsed?.builtAt.getFullYear()).toBe(2026);
		expect(parsed?.builtAt.getMonth()).toBe(8);
		expect(parsed?.builtAt.getDate()).toBe(2);
		expect(parsed?.builtAt.getHours()).toBe(17);
		expect(parsed?.builtAt.getMinutes()).toBe(13);
	});

	it("tolerates a trailing commit stamp", () => {
		expect(parseNightlyVersion("0.10.4-nightly.202607071200+abc123")?.base).toBe("0.10.4");
	});

	it("returns null for stable, feature and malformed versions", () => {
		expect(parseNightlyVersion("0.12.10")).toBeNull();
		expect(parseNightlyVersion("0.12.0-pr4473.202608271542")).toBeNull();
		expect(parseNightlyVersion(undefined)).toBeNull();
		expect(parseNightlyVersion("0.12.11-nightly.2026")).toBeNull();
		expect(parseNightlyVersion("0.12.11-nightly.202699021713")).toBeNull();
	});
});
