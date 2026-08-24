// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectLocalHarness, disconnectCloudHarness } from "./cloud-beta";

describe("cloud harness credentials", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("reads Claude credentials in Electron main and sends them only to the Cloud API", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-local-claude-token");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ providerConnection: { id: "connection_1" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(connectLocalHarness("fake-cloud-access-token", "claude-code")).resolves.toMatchObject({
			harness: "claude-code",
			connected: true,
			source: "environment",
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/api/cloud/v1/me/providers/claude-code");
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fake-cloud-access-token");
		expect(JSON.parse(String(init.body))).toEqual({
			credentialType: "oauth_token",
			secret: "fake-local-claude-token",
		});
	});

	it("supports revoking a stored harness connection", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(disconnectCloudHarness("fake-cloud-access-token", "codex")).resolves.toBeUndefined();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/api/cloud/v1/me/providers/codex");
		expect(init.method).toBe("DELETE");
	});
});
