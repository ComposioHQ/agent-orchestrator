import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	dialog: { showMessageBox: vi.fn() },
	ipcMain: { handle: vi.fn() },
}));

import { createCloudCredentialCustody } from "./cloud-credentials";

const secretJSON = JSON.stringify({
	claudeAiOauth: { accessToken: "claude-secret-token", refreshToken: "refresh-secret" },
});

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("Electron-main Cloud credential custody", () => {
	it("requires native consent before reading Keychain", async () => {
		const readClaudeKeychain = vi.fn(async () => Buffer.from(secretJSON));
		const fetch = vi.fn<typeof globalThis.fetch>();
		const custody = createCloudCredentialCustody({
			confirmImport: async () => false,
			readClaudeKeychain,
			fetch,
			accessToken: async () => "ao-access",
			apiBaseUrl: () => "https://cloud.example",
		});
		await expect(custody.importClaude("org-1")).rejects.toThrow(/cancelled/);
		expect(readClaudeKeychain).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uploads from main with auth, returns only metadata, and erases the Keychain buffer", async () => {
		const secret = Buffer.from(secretJSON);
		let requestBody = "";
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			requestBody = String(init?.body);
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer ao-access");
			return jsonResponse({
				providerConnection: {
					id: "credential-1",
					provider: "claude-code",
					config: { credentialType: "oauth_token" },
					updatedAt: "2026-08-23T00:00:00Z",
				},
			});
		});
		const custody = createCloudCredentialCustody({
			confirmImport: async () => true,
			readClaudeKeychain: async () => secret,
			fetch,
			accessToken: async () => "ao-access",
			apiBaseUrl: () => "https://cloud.example/",
		});
		const result = await custody.importClaude("org-1");
		expect(result).toEqual({
			connected: true,
			provider: "claude-code",
			credentialType: "oauth_token",
			updatedAt: "2026-08-23T00:00:00Z",
		});
		expect(result).not.toHaveProperty("secret");
		expect(requestBody).toContain("claude-secret-token");
		expect([...secret].every((value) => value === 0)).toBe(true);
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://cloud.example/api/cloud/v1/orgs/org-1/provider-connections/agents/claude-code",
		);
	});

	it("uses redacted status and authenticated delete endpoints", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			return jsonResponse({ providerConnections: [] });
		});
		const custody = createCloudCredentialCustody({
			fetch,
			accessToken: async () => "ao-access",
			apiBaseUrl: () => "https://cloud.example",
		});
		await expect(custody.status("org-1")).resolves.toEqual({ connected: false, provider: "claude-code" });
		await expect(custody.remove("org-1")).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("does not reflect a credential-bearing server error", async () => {
		const custody = createCloudCredentialCustody({
			fetch: async () => new Response(secretJSON, { status: 500 }),
			accessToken: async () => "ao-access",
			apiBaseUrl: () => "https://cloud.example",
		});
		await expect(custody.status("org-1")).rejects.toThrow("AO Cloud credential request failed (500).");
	});
});
