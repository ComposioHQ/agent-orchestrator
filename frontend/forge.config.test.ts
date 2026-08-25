import { describe, expect, it } from "vitest";
import config, { extraResourcesForPlatform } from "./forge.config";

describe("native runtime resources", () => {
	it.each(["darwin", "linux"] as const)("bundles tmux on %s", (platform) => {
		expect(extraResourcesForPlatform(platform)).toContain("tmux");
	});

	it("does not bundle tmux on Windows", () => {
		expect(extraResourcesForPlatform("win32")).not.toContain("tmux");
	});
});

describe("packaged authentication callback registration", () => {
	it("declares ao-app in the macOS bundle and Linux package metadata", () => {
		expect(config.packagerConfig?.protocols).toEqual([
			{
				name: "Agent Orchestrator authentication callback",
				schemes: ["ao-app"],
			},
		]);

		const makers = config.makers as Array<{
			name?: string;
			config?: { options?: { mimeType?: string[] } };
		}>;
		for (const name of [
			"@electron-forge/maker-deb",
			"@electron-forge/maker-rpm",
		]) {
			const maker = makers.find((candidate) => candidate.name === name);
			expect(maker?.config?.options?.mimeType).toEqual([
				"x-scheme-handler/ao-app",
			]);
		}
	});
});

describe("packaged native dependencies", () => {
	it("keeps the SQLite runtime available to the Vite main bundle", () => {
		const ignore = config.packagerConfig?.ignore;
		expect(ignore).toBeTypeOf("function");
		if (typeof ignore !== "function") return;

		expect(ignore("/.vite/build/main.js")).toBe(false);
		expect(ignore("/node_modules")).toBe(false);
		expect(ignore("/node_modules/better-sqlite3/build/Release/better_sqlite3.node")).toBe(false);
		expect(ignore("/node_modules/bindings/bindings.js")).toBe(false);
		expect(ignore("/node_modules/file-uri-to-path/index.js")).toBe(false);
		expect(ignore("/node_modules/react/index.js")).toBe(true);
		expect(ignore("/src/main.ts")).toBe(true);
		expect(config.hooks?.prePackage).toBeTypeOf("function");
	});
});
