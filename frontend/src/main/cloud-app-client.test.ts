import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedAppClient } from "./cloud-app-client";

describe("hosted application API client", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the generated application schema with main-owned auth and organization headers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ projects: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));
		vi.stubGlobal("fetch", fetchMock);
		const client = createHostedAppClient({
			baseUrl: "https://cloud.example.test",
			getAccessToken: async () => "main-process-token",
		});

		await expect(client.listProjects("org-1")).resolves.toEqual({ projects: [] });
		const request = fetchMock.mock.calls[0]?.[0] as Request;
		expect(request.url).toBe("https://cloud.example.test/api/v1/projects");
		expect(request.headers.get("Authorization")).toBe("Bearer main-process-token");
		expect(request.headers.get("X-AO-Org")).toBe("org-1");
	});

	it("sends session creation through the canonical route with an idempotency key and no branch override", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
			promptBytes: 0,
			systemPromptBytes: 0,
			session: { id: "session-1" },
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}));
		vi.stubGlobal("fetch", fetchMock);
		const client = createHostedAppClient({
			baseUrl: "https://cloud.example.test",
			getAccessToken: async () => "main-process-token",
		});

		await client.spawnSession(
			"org-1",
			{ projectId: "project-1", kind: "orchestrator", harness: "codex" },
			"request-1",
		);
		const request = fetchMock.mock.calls[0]?.[0] as Request;
		expect(request.url).toBe("https://cloud.example.test/api/v1/sessions");
		expect(request.headers.get("Idempotency-Key")).toBe("request-1");
		const body = await request.json();
		expect(body).toEqual({ projectId: "project-1", kind: "orchestrator", harness: "codex" });
		expect(body).not.toHaveProperty("branch");
	});
});
