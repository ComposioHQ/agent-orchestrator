// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCloudAccessToken: vi.fn<(dataDir: string) => Promise<string | null>>(),
	ipcMainHandle: vi.fn(),
	ipcMainOn: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: { handle: mocks.ipcMainHandle, on: mocks.ipcMainOn },
}));

vi.mock("./cloud-auth", () => ({
	getCloudAccessToken: mocks.getCloudAccessToken,
}));

import {
	CLOUD_CP_CLOSE_STREAM_CHANNEL,
	CLOUD_CP_OPEN_STREAM_CHANNEL,
	CLOUD_CP_REQUEST_CHANNEL,
	MAX_STREAMS_PER_WEBCONTENTS,
	cloudCpStreamChannel,
	createCloudCpProxy,
	installCloudCpProxy,
	type CloudCpStreamEvent,
	type CloudCpStreamSender,
} from "./cloud-cp-proxy";

const DATA_DIR = "/tmp/ao-test-data";
const BASE = "https://cp.example.com";
const INIT = { baseUrl: BASE, path: "/api/cloud/v1/me", method: "GET" };

interface RecordedFetch {
	url: string;
	init: RequestInit | undefined;
}

function makeProxy(
	responses: Array<Response | Error> | ((url: string, init?: RequestInit) => Promise<Response>),
): { proxy: ReturnType<typeof createCloudCpProxy>; calls: RecordedFetch[] } {
	const calls: RecordedFetch[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), init });
		if (typeof responses === "function") return responses(String(input), init);
		const next = responses.shift();
		if (next === undefined) throw new Error("unexpected fetch call");
		if (next instanceof Error) throw next;
		return next;
	};
	return { proxy: createCloudCpProxy(() => DATA_DIR, { fetchImpl }), calls };
}

function makeSender(id = 1): {
	sender: CloudCpStreamSender;
	sent: Array<{ channel: string; event: CloudCpStreamEvent }>;
	destroy: () => void;
} {
	const sent: Array<{ channel: string; event: CloudCpStreamEvent }> = [];
	const destroyedListeners: Array<() => void> = [];
	let destroyed = false;
	const sender: CloudCpStreamSender = {
		id,
		isDestroyed: () => destroyed,
		send: (channel, event) => {
			sent.push({ channel, event });
		},
		once: (_event, listener) => {
			destroyedListeners.push(listener);
		},
	};
	return {
		sender,
		sent,
		destroy: () => {
			destroyed = true;
			for (const listener of destroyedListeners) listener();
		},
	};
}

function sseResponse(): {
	response: Response;
	push: (text: string) => void;
	close: () => void;
	fail: (error: Error) => void;
} {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const encoder = new TextEncoder();
	return {
		response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
		push: (text) => controller.enqueue(encoder.encode(text)),
		close: () => controller.close(),
		fail: (error) => controller.error(error),
	};
}

function signedIn(token = "tok_123"): void {
	mocks.getCloudAccessToken.mockReset();
	mocks.getCloudAccessToken.mockResolvedValue(token);
}

function signedOut(): void {
	mocks.getCloudAccessToken.mockReset();
	mocks.getCloudAccessToken.mockResolvedValue(null);
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("cloud-cp proxy request validation", () => {
	it("rejects a non-https baseUrl without touching the network", async () => {
		signedIn();
		const { proxy, calls } = makeProxy([]);
		await expect(proxy.request({ ...INIT, baseUrl: "http://cp.example.com" })).rejects.toThrow(/https/);
		expect(calls).toHaveLength(0);
	});

	it("allows http only for localhost and 127.0.0.1", async () => {
		signedIn();
		const { proxy, calls } = makeProxy([
			new Response("{}", { status: 200 }),
			new Response("{}", { status: 200 }),
		]);
		await expect(proxy.request({ ...INIT, baseUrl: "http://localhost:8443" })).resolves.toMatchObject({
			status: 200,
		});
		await expect(proxy.request({ ...INIT, baseUrl: "http://127.0.0.1:9443" })).resolves.toMatchObject({
			status: 200,
		});
		expect(calls.map((c) => c.url)).toEqual([
			"http://localhost:8443/api/cloud/v1/me",
			"http://127.0.0.1:9443/api/cloud/v1/me",
		]);
	});

	it("rejects paths outside /api/cloud/v1", async () => {
		signedIn();
		const { proxy, calls } = makeProxy([]);
		await expect(proxy.request({ ...INIT, path: "/api/other/me" })).rejects.toThrow(/\/api\/cloud\/v1/);
		await expect(proxy.request({ ...INIT, path: "/api/cloud/v1secrets" })).rejects.toThrow(/\/api\/cloud\/v1/);
		await expect(proxy.request({ ...INIT, path: "" })).rejects.toThrow(/\/api\/cloud\/v1/);
		expect(calls).toHaveLength(0);
	});

	it("rejects dot-segment traversal that escapes the API prefix after normalization", async () => {
		signedIn();
		const { proxy, calls } = makeProxy([]);
		await expect(proxy.request({ ...INIT, path: "/api/cloud/v1/../../internal/metrics" })).rejects.toThrow(
			/normalization/,
		);
		await expect(proxy.request({ ...INIT, path: "/api/cloud/v1/%2e%2e/%2e%2e/admin" })).rejects.toThrow(
			/normalization/,
		);
		expect(calls).toHaveLength(0);
	});

	it("rejects malformed payloads", async () => {
		signedIn();
		const { proxy, calls } = makeProxy([]);
		await expect(proxy.request("nope")).rejects.toThrow(/must be an object/);
		await expect(proxy.request({ ...INIT, method: "GET /x" })).rejects.toThrow(/method/);
		await expect(proxy.request({ ...INIT, headers: { a: 1 } })).rejects.toThrow(/headers/);
		await expect(proxy.request({ ...INIT, body: 5 })).rejects.toThrow(/body/);
		expect(calls).toHaveLength(0);
	});
});

describe("cloud-cp proxy request auth", () => {
	it("responds 401-shaped without calling the network when signed out", async () => {
		signedOut();
		const { proxy, calls } = makeProxy([]);
		const result = await proxy.request(INIT);
		expect(result.status).toBe(401);
		expect(JSON.parse(result.body)).toMatchObject({ code: "no_token" });
		expect(calls).toHaveLength(0);
		expect(mocks.getCloudAccessToken).toHaveBeenCalledWith(DATA_DIR);
	});

	it("attaches the bearer token and never trusts a renderer Authorization header", async () => {
		signedIn("tok_real");
		const { proxy, calls } = makeProxy([
			new Response('{"user":"u1"}', { status: 200, headers: { "x-request-id": "req_1" } }),
		]);
		const result = await proxy.request({
			...INIT,
			method: "post",
			headers: { Authorization: "Bearer forged-by-renderer", "Content-Type": "application/json" },
			body: '{"name":"x"}',
		});

		expect(calls).toHaveLength(1);
		const sentHeaders = new Headers(calls[0].init?.headers);
		expect(sentHeaders.get("authorization")).toBe("Bearer tok_real");
		expect(sentHeaders.get("content-type")).toBe("application/json");
		expect(calls[0].init?.method).toBe("POST");
		expect(calls[0].init?.body).toBe('{"name":"x"}');
		expect(result).toEqual({
			status: 200,
			headers: expect.objectContaining({ "x-request-id": "req_1" }),
			body: '{"user":"u1"}',
		});
	});

	it("passes non-2xx responses through untouched", async () => {
		signedIn();
		const { proxy } = makeProxy([new Response('{"message":"nope"}', { status: 403 })]);
		await expect(proxy.request(INIT)).resolves.toMatchObject({ status: 403, body: '{"message":"nope"}' });
	});
});

describe("cloud-cp proxy streams", () => {
	const STREAM_INIT = {
		baseUrl: BASE,
		path: "/api/cloud/v1/orgs/o1/sessions/s1/events",
		method: "GET",
		headers: { Accept: "text/event-stream" },
	};

	it("forwards chunks on the per-stream channel and ends cleanly", async () => {
		signedIn();
		const sse = sseResponse();
		const { proxy } = makeProxy([sse.response]);
		const { sender, sent } = makeSender();

		const { streamId } = await proxy.openStream(sender, STREAM_INIT);
		expect(streamId).toBeTruthy();

		sse.push("data: one\n\n");
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		sse.push("data: two\n\n");
		sse.close();
		await vi.waitFor(() => expect(sent.map(({ event }) => event.type)).toEqual(["chunk", "chunk", "end"]));

		const channel = cloudCpStreamChannel(streamId);
		expect(sent.every((entry) => entry.channel === channel)).toBe(true);
		expect(sent[0].event).toEqual({ type: "chunk", data: "data: one\n\n" });
		expect(sent[1].event).toEqual({ type: "chunk", data: "data: two\n\n" });
	});

	it("forwards a mid-stream failure as an error event", async () => {
		signedIn();
		const sse = sseResponse();
		const { proxy } = makeProxy([sse.response]);
		const { sender, sent } = makeSender();

		await proxy.openStream(sender, STREAM_INIT);
		sse.push("data: one\n\n");
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		sse.fail(new Error("connection reset"));
		await vi.waitFor(() =>
			expect(sent.at(-1)?.event).toEqual({ type: "error", message: "connection reset" }),
		);
	});

	it("throws a 401-marked error without fetching when signed out", async () => {
		signedOut();
		const { proxy, calls } = makeProxy([]);
		const { sender } = makeSender();
		await expect(proxy.openStream(sender, STREAM_INIT)).rejects.toThrow(/CLOUD_CP_STREAM_ERROR 401 /);
		expect(calls).toHaveLength(0);
	});

	it("surfaces a non-2xx stream response as a status-marked error", async () => {
		signedIn();
		const { proxy } = makeProxy([
			new Response('{"message":"session not found"}', { status: 404 }),
		]);
		const { sender } = makeSender();
		await expect(proxy.openStream(sender, STREAM_INIT)).rejects.toThrow(
			/CLOUD_CP_STREAM_ERROR 404 session not found/,
		);
	});

	it("stops forwarding and aborts the fetch when the renderer closes the stream", async () => {
		signedIn();
		const sse = sseResponse();
		const { proxy, calls } = makeProxy([sse.response]);
		const { sender, sent } = makeSender();

		const { streamId } = await proxy.openStream(sender, STREAM_INIT);
		sse.push("data: one\n\n");
		await vi.waitFor(() => expect(sent).toHaveLength(1));

		proxy.closeStream(sender, streamId);
		expect(calls[0].init?.signal?.aborted).toBe(true);
		sse.push("data: late\n\n");
		await settle();
		expect(sent).toHaveLength(1);
	});

	it("ignores a close from a different webContents", async () => {
		signedIn();
		const sse = sseResponse();
		const { proxy, calls } = makeProxy([sse.response]);
		const { sender } = makeSender(1);
		const other = makeSender(2);

		const { streamId } = await proxy.openStream(sender, STREAM_INIT);
		proxy.closeStream(other.sender, streamId);
		expect(calls[0].init?.signal?.aborted).toBe(false);
	});

	it("cleans up every stream when the webContents is destroyed", async () => {
		signedIn();
		const first = sseResponse();
		const second = sseResponse();
		const { proxy, calls } = makeProxy([first.response, second.response]);
		const { sender, sent, destroy } = makeSender();

		await proxy.openStream(sender, STREAM_INIT);
		await proxy.openStream(sender, STREAM_INIT);
		destroy();

		expect(calls[0].init?.signal?.aborted).toBe(true);
		expect(calls[1].init?.signal?.aborted).toBe(true);
		first.push("data: late\n\n");
		second.push("data: late\n\n");
		await settle();
		expect(sent).toHaveLength(0);
	});

	it("caps concurrent streams per webContents and frees slots on close", async () => {
		signedIn();
		const { proxy } = makeProxy(async () => sseResponse().response);
		const { sender } = makeSender();

		const streamIds: string[] = [];
		for (let i = 0; i < MAX_STREAMS_PER_WEBCONTENTS; i += 1) {
			const { streamId } = await proxy.openStream(sender, STREAM_INIT);
			streamIds.push(streamId);
		}
		await expect(proxy.openStream(sender, STREAM_INIT)).rejects.toThrow(/CLOUD_CP_STREAM_ERROR 429 /);

		proxy.closeStream(sender, streamIds[0]);
		await expect(proxy.openStream(sender, STREAM_INIT)).resolves.toMatchObject({
			streamId: expect.any(String),
		});
	});

	it("validates stream inits with the same rules as requests", async () => {
		signedIn();
		const { proxy, calls } = makeProxy([]);
		const { sender } = makeSender();
		await expect(proxy.openStream(sender, { ...STREAM_INIT, baseUrl: "http://cp.example.com" })).rejects.toThrow(
			/https/,
		);
		await expect(proxy.openStream(sender, { ...STREAM_INIT, path: "/elsewhere" })).rejects.toThrow(
			/\/api\/cloud\/v1/,
		);
		expect(calls).toHaveLength(0);
	});
});

describe("installCloudCpProxy", () => {
	it("registers the request/openStream/closeStream IPC channels", () => {
		installCloudCpProxy(() => DATA_DIR);
		expect(mocks.ipcMainHandle).toHaveBeenCalledWith(CLOUD_CP_REQUEST_CHANNEL, expect.any(Function));
		expect(mocks.ipcMainHandle).toHaveBeenCalledWith(CLOUD_CP_OPEN_STREAM_CHANNEL, expect.any(Function));
		expect(mocks.ipcMainOn).toHaveBeenCalledWith(CLOUD_CP_CLOSE_STREAM_CHANNEL, expect.any(Function));
	});
});
