import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "./forge.config";

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

describe("bundled ao CLI on PATH", () => {
	const makers = config.makers as Array<{
		name?: string;
		config?: { options?: { scripts?: Record<string, string> } };
	}>;
	const scriptsFor = (name: string) =>
		makers.find((candidate) => candidate.name === name)?.config?.options
			?.scripts;

	it("runs maintainer scripts that link and unlink /usr/bin/ao", () => {
		// The link cannot live in either payload (see LINUX_CLI_SCRIPTS in
		// forge.config.ts), so deb and rpm each need BOTH halves wired up: link
		// on install, unlink on removal. Half of it is a dangling symlink left
		// behind after uninstall.
		expect(scriptsFor("@electron-forge/maker-deb")).toEqual({
			postinst: "packaging/linux/deb-postinst.sh",
			postrm: "packaging/linux/deb-postrm.sh",
		});
		expect(scriptsFor("@electron-forge/maker-rpm")).toEqual({
			post: "packaging/linux/rpm-post.sh",
			postun: "packaging/linux/rpm-postun.sh",
		});
	});

	it("points every script at a real file that targets the bundled binary", () => {
		// Both makers resolve these paths at build time and fail the make if one
		// is missing, so a rename that misses this config breaks the release.
		const paths = [
			...Object.values(scriptsFor("@electron-forge/maker-deb") ?? {}),
			...Object.values(scriptsFor("@electron-forge/maker-rpm") ?? {}),
		];
		expect(paths).toHaveLength(4);
		for (const relativePath of paths) {
			const body = readFileSync(join(__dirname, relativePath), "utf8");
			// The CLI and the daemon are the same binary, shipped here by
			// scripts/build-daemon.mjs via packagerConfig.extraResource.
			expect(body).toContain(
				"target=/usr/lib/agent-orchestrator/resources/daemon/ao",
			);
			expect(body).toContain("link=/usr/bin/ao");
		}
	});
});
