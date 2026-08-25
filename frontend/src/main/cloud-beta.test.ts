// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectLocalHarness, createCloudProject, disconnectCloudHarness } from "./cloud-beta";

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

	it("sends the local Codex auth bundle without exposing it in the result", async () => {
		const codexHome = await mkdtemp(path.join(os.tmpdir(), "ao-codex-auth-test-"));
		const auth = {
			tokens: {
				access_token: "fake-local-codex-access",
				refresh_token: "fake-local-codex-refresh",
				account_id: "account-123",
			},
		};
		await writeFile(path.join(codexHome, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
		vi.stubEnv("CODEX_HOME", codexHome);
		vi.stubEnv("CODEX_ACCESS_TOKEN", "");
		vi.stubEnv("OPENAI_API_KEY", "");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ providerConnection: { id: "connection_1" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		try {
			const result = await connectLocalHarness("fake-cloud-access-token", "codex");
			expect(result).toEqual({ harness: "codex", connected: true, source: "codex-auth" });
			expect(result).not.toHaveProperty("secret");
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(JSON.parse(String(init.body))).toEqual({
				credentialType: "auth_json",
				secret: JSON.stringify(auth),
			});
		} finally {
			await rm(codexHome, { recursive: true, force: true });
		}
	});

	it("stores Cloud agent defaults in the project config", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ project: { id: "project-1" } }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await createCloudProject("fake-cloud-access-token", "org-1", {
			displayName: "Example",
			repositoryUrl: "https://github.com/acme/example.git",
			defaultBranch: "main",
			workerAgent: "codex",
			orchestratorAgent: "claude-code",
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({
			displayName: "Example",
			repositoryUrl: "https://github.com/acme/example.git",
			defaultBranch: "main",
			config: {
				worker: { agent: "codex" },
				orchestrator: { agent: "claude-code" },
			},
		});
	});
});
