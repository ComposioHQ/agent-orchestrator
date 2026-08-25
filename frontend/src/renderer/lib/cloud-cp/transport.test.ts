import { describe, expect, it, vi } from "vitest";
import type { CloudCpProxyRequestInit, CloudCpProxyResponse } from "../../../main/cloud-cp-proxy";
import { createCloudCpClient } from "./client";
import { CloudCpAuthError } from "./errors";
import { createBridgedFetch } from "./transport";

function makeBridge(...responses: CloudCpProxyResponse[]) {
	const calls: CloudCpProxyRequestInit[] = [];
	const request = vi.fn(async (init: CloudCpProxyRequestInit) => {
		calls.push(init);
		const next = responses.shift();
		if (next === undefined) throw new Error("unexpected bridge request");
		return next;
	});
	return { bridge: { request }, calls };
}

function jsonResponse(status: number, body: unknown): CloudCpProxyResponse {
	return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("createBridgedFetch", () => {
	it("maps url, method, headers, and body onto the bridge init", async () => {
		const { bridge, calls } = makeBridge(jsonResponse(200, { ok: true }));
		const fetchImpl = createBridgedFetch(bridge);

		await fetchImpl("https://cp.example.com/api/cloud/v1/orgs/o1/projects?limit=5", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": "k1" },
			body: '{"name":"x"}',
		});

		expect(calls).toEqual([
			{
				baseUrl: "https://cp.example.com",
				path: "/api/cloud/v1/orgs/o1/projects?limit=5",
				method: "POST",
				headers: expect.objectContaining({
					"content-type": "application/json",
					"idempotency-key": "k1",
				}),
				body: '{"name":"x"}',
			},
		]);
	});

	it("keeps a subpath-mounted control plane in baseUrl", async () => {
		const { bridge, calls } = makeBridge(jsonResponse(200, {}));
		await createBridgedFetch(bridge)("https://cp.example.com/mount/api/cloud/v1/me");
		expect(calls[0]).toMatchObject({
			baseUrl: "https://cp.example.com/mount",
			path: "/api/cloud/v1/me",
			method: "GET",
		});
	});

	it("builds a Response the caller can consume as JSON", async () => {
		const { bridge } = makeBridge(jsonResponse(201, { id: "p1" }));
		const response = await createBridgedFetch(bridge)("https://cp.example.com/api/cloud/v1/me");
		expect(response.status).toBe(201);
		expect(response.headers.get("content-type")).toBe("application/json");
		await expect(response.json()).resolves.toEqual({ id: "p1" });
	});

	it("builds a body-less Response for 204s", async () => {
		const { bridge } = makeBridge({ status: 204, headers: {}, body: "" });
		const response = await createBridgedFetch(bridge)("https://cp.example.com/api/cloud/v1/me", {
			method: "DELETE",
		});
		expect(response.status).toBe(204);
		await expect(response.text()).resolves.toBe("");
	});

	it("refuses SSE requests and points at the stream bridge", async () => {
		const { bridge, calls } = makeBridge();
		await expect(
			createBridgedFetch(bridge)("https://cp.example.com/api/cloud/v1/orgs/o1/sessions/s1/events", {
				headers: { Accept: "text/event-stream" },
			}),
		).rejects.toThrow(/subscribeSessionEventsBridged/);
		expect(calls).toHaveLength(0);
	});

	it("refuses non-string bodies", async () => {
		const { bridge, calls } = makeBridge();
		await expect(
			createBridgedFetch(bridge)("https://cp.example.com/api/cloud/v1/me", {
				method: "POST",
				body: new Uint8Array([1, 2, 3]),
			}),
		).rejects.toThrow(/string request bodies/);
		expect(calls).toHaveLength(0);
	});

	it("refuses URLs outside the control-plane prefix", async () => {
		const { bridge, calls } = makeBridge();
		await expect(createBridgedFetch(bridge)("https://cp.example.com/other/path")).rejects.toThrow(
			/\/api\/cloud\/v1/,
		);
		expect(calls).toHaveLength(0);
	});

	it("rejects with the abort reason when the signal fires", async () => {
		const request = vi.fn(() => new Promise<CloudCpProxyResponse>(() => undefined));
		const controller = new AbortController();
		const pending = createBridgedFetch({ request })("https://cp.example.com/api/cloud/v1/me", {
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("plugs into createCloudCpClient as its fetchImpl", async () => {
		const { bridge, calls } = makeBridge(jsonResponse(200, { user: { id: "u1" }, orgs: [] }));
		const client = createCloudCpClient({
			baseUrl: "https://cp.example.com",
			// The renderer never sees the real token; main replaces this header.
			getToken: async () => "renderer-placeholder",
			fetchImpl: createBridgedFetch(bridge),
		});

		await expect(client.me()).resolves.toEqual({ user: { id: "u1" }, orgs: [] });
		expect(calls[0]).toMatchObject({ baseUrl: "https://cp.example.com", path: "/api/cloud/v1/me", method: "GET" });
	});

	it("lets a proxied 401 surface as CloudCpAuthError through the typed client", async () => {
		const { bridge } = makeBridge(
			jsonResponse(401, { error: "unauthorized", code: "no_token", message: "No AO Cloud session is available." }),
		);
		const client = createCloudCpClient({
			baseUrl: "https://cp.example.com",
			getToken: async () => "renderer-placeholder",
			fetchImpl: createBridgedFetch(bridge),
		});

		await expect(client.me()).rejects.toBeInstanceOf(CloudCpAuthError);
	});
});
