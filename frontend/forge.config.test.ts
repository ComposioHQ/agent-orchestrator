import { describe, expect, it } from "vitest";
import path from "node:path";
import config, {
	extraResourcesForPlatform,
	isPackagedNodeRuntime,
	optionsForFile,
} from "./forge.config";

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

const signedBundle = path.join("/tmp", "Agent Orchestrator.app", "Contents", "Resources");
const packagedNode = path.join(signedBundle, "acp-runtime", "node", "bin", "node");

describe("macOS signing entitlements", () => {
	it("matches the Node runtime AO packages for the ACP adapter", () => {
		expect(isPackagedNodeRuntime(packagedNode)).toBe(true);
	});

	it("leaves every other signed binary on the signer's defaults", () => {
		// Electron's helpers need @electron/osx-sign's inherit entitlements; a
		// blanket override would break their signature.
		for (const other of [
			path.join(signedBundle, "acp-runtime", "node", "bin", "npx"),
			path.join(signedBundle, "acp-runtime", "node_modules", ".bin", "node"),
			path.join(signedBundle, "agent-browser", "node"),
			path.join(signedBundle, "..", "Frameworks", "Electron Helper.app", "Contents", "MacOS", "Electron Helper"),
		]) {
			expect(isPackagedNodeRuntime(other)).toBe(false);
		}
	});

	// Without allow-unsigned-executable-memory V8's baseline compiler aborts on
	// Intel Macs, killing the Claude ACP adapter before the handshake (#4442).
	it("gives the packaged Node runtime AO's entitlements", () => {
		expect(optionsForFile(packagedNode)).toEqual({
			entitlements: "assets/entitlements.acp-runtime.plist",
		});
	});

	it("returns no overrides for other files", () => {
		expect(optionsForFile(path.join(signedBundle, "agent-browser", "node"))).toEqual({});
	});
});
