import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));

import {
	CLAUDE_CODE_PROVIDER,
	CLOUD_CREDENTIAL_IMPORT_CHANNEL,
	createCloudCredentialImporter,
} from "./cloud-credential-import";

const credentialJSON = Buffer.from(
	JSON.stringify({ claudeAiOauth: { accessToken: "secret-marker", refreshToken: "refresh-marker" } }),
);

const uploadedMetadata = {
	credentialId: "credential-1",
	provider: CLAUDE_CODE_PROVIDER,
	version: 1,
	updatedAt: "2026-08-23T00:00:00Z",
};

describe("Electron-main Cloud credential import consent seam", () => {
	it("uses the canonical provider and one narrow IPC name", () => {
		expect(CLAUDE_CODE_PROVIDER).toBe("claude-code");
		expect(CLAUDE_CODE_PROVIDER).not.toBe("claude");
		expect(CLOUD_CREDENTIAL_IMPORT_CHANNEL).toBe("cloudCredentials:importClaudeCode");
	});

	it("authorizes and obtains native consent before reading Keychain", async () => {
		const calls: string[] = [];
		const importer = createCloudCredentialImporter({
			authorize: async () => {
				calls.push("authorize");
			},
			confirmImport: async () => {
				calls.push("consent");
				return false;
			},
			readCredential: async () => {
				calls.push("keychain");
				return Buffer.from(credentialJSON);
			},
			uploadCredential: async () => {
				calls.push("upload");
				return uploadedMetadata;
			},
		});
		await expect(importer.importClaudeCode()).rejects.toThrow(/cancelled/);
		expect(calls).toEqual(["authorize", "consent"]);
	});

	it("uploads bounded bytes, returns redacted metadata, and zeros the source", async () => {
		const source = Buffer.concat([credentialJSON, Buffer.from("\n")]);
		let uploadedReference: Uint8Array | undefined;
		const importer = createCloudCredentialImporter({
			authorize: async () => undefined,
			confirmImport: async () => true,
			readCredential: async () => source,
			uploadCredential: async (upload) => {
				expect(upload.provider).toBe("claude-code");
				expect(Buffer.from(upload.secret).includes(Buffer.from("secret-marker"))).toBe(true);
				uploadedReference = upload.secret;
				return { ...uploadedMetadata, secret: "adapter-must-not-leak" } as typeof uploadedMetadata;
			},
		});
		const result = await importer.importClaudeCode();
		expect(result).toEqual(uploadedMetadata);
		expect(result).not.toHaveProperty("secret");
		expect(source.every((byte) => byte === 0)).toBe(true);
		expect(uploadedReference && [...uploadedReference].every((byte) => byte === 0)).toBe(true);
	});

	it("zeros credential bytes and redacts a credential-bearing upload failure", async () => {
		const source = Buffer.from(credentialJSON);
		const importer = createCloudCredentialImporter({
			authorize: async () => undefined,
			confirmImport: async () => true,
			readCredential: async () => source,
				uploadCredential: async () => {
					throw new Error("server reflected secret-marker");
				},
			});
		let observed = "";
		try {
			await importer.importClaudeCode();
		} catch (error) {
			observed = error instanceof Error ? error.message : String(error);
		}
		expect(observed).toBe("Claude Code credential import failed.");
		expect(observed).not.toContain("secret-marker");
		expect(source.every((byte) => byte === 0)).toBe(true);
	});

	it("rejects and zeros oversized or malformed credentials before upload", async () => {
		for (const source of [Buffer.alloc(64 * 1024 + 1, 1), Buffer.from('{"provider":"claude"}')]) {
			const uploadCredential = vi.fn(async () => uploadedMetadata);
			const importer = createCloudCredentialImporter({
				authorize: async () => undefined,
				confirmImport: async () => true,
				readCredential: async () => source,
				uploadCredential,
			});
			await expect(importer.importClaudeCode()).rejects.toThrow(/invalid/);
			expect(uploadCredential).not.toHaveBeenCalled();
			expect(source.every((byte) => byte === 0)).toBe(true);
		}
	});

	it("contains no IPC registration, local file write, shell, argv secret, or env secret path", () => {
		const source = readFileSync("src/main/cloud-credential-import.ts", "utf8");
		for (const forbidden of ["ipcMain", "writeFile", "appendFile", "spawn(", "shell: true", "process.env", "git config"]) {
			expect(source).not.toContain(forbidden);
		}
		expect(source).toContain('"/usr/bin/security"');
		expect(source).toContain("find-generic-password");
	});
});
