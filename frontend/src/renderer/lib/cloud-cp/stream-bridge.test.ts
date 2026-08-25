import { describe, expect, it, vi } from "vitest";
import type { CloudCpProxyRequestInit, CloudCpStreamEvent } from "../../../main/cloud-cp-proxy";
import { CloudCpAuthError, CloudCpError } from "./errors";
import { subscribeSessionEventsBridged, type CloudCpStreamBridge } from "./stream-bridge";
import type { CloudCpClientEvent } from "./types";

const BASE = "https://cp.example.com";

function makeBridge(openStream?: CloudCpStreamBridge["openStream"]) {
	const listeners = new Map<string, (event: CloudCpStreamEvent) => void>();
	const openCalls: CloudCpProxyRequestInit[] = [];
	const bridge: CloudCpStreamBridge = {
		openStream:
			openStream ??
			(async (init) => {
				openCalls.push(init);
				return { streamId: "stream_1" };
			}),
		closeStream: vi.fn(),
		onStreamEvent: (streamId, listener) => {
			listeners.set(streamId, listener);
			return () => {
				listeners.delete(streamId);
			};
		},
	};
	return {
		bridge,
		openCalls,
		listeners,
		emit: (event: CloudCpStreamEvent) => listeners.get("stream_1")?.(event),
	};
}

function frame(payload: unknown, seq?: number): string {
	const id = seq === undefined ? "" : `id: ${seq}\n`;
	return `${id}event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe("subscribeSessionEventsBridged", () => {
	it("opens the session events stream with the exact CP path and parses frames into events", async () => {
		const { bridge, openCalls, emit, listeners } = makeBridge();
		const events: CloudCpClientEvent[] = [];

		const done = subscribeSessionEventsBridged({
			baseUrl: `${BASE}/`,
			orgId: "org 1",
			sessionId: "sess/2",
			after: 41,
			onEvent: (event) => events.push(event),
			bridge,
		});
		await vi.waitFor(() => expect(listeners.size).toBe(1));

		expect(openCalls).toEqual([
			{
				baseUrl: BASE,
				path: "/api/cloud/v1/orgs/org%201/sessions/sess%2F2/events?after=41",
				method: "GET",
				headers: { Accept: "text/event-stream" },
			},
		]);

		// One frame split across two chunks plus a second complete frame: the
		// shared SSE parser must buffer across chunk boundaries.
		emit({ type: "chunk", data: "event: message\ndata: {\"type\":\"agent_" });
		emit({ type: "chunk", data: "message\",\"seq\":42}\n\n" });
		emit({ type: "chunk", data: frame({ type: "turn_completed", seq: 43 }, 43) });
		emit({ type: "end" });

		await done;
		expect(events).toEqual([
			{ type: "agent_message", seq: 42 },
			{ type: "turn_completed", seq: 43 },
		]);
		expect(listeners.size).toBe(0);
	});

	it("flushes a final unterminated frame when the stream ends", async () => {
		const { bridge, emit, listeners } = makeBridge();
		const events: CloudCpClientEvent[] = [];
		const done = subscribeSessionEventsBridged({
			baseUrl: BASE,
			orgId: "o1",
			sessionId: "s1",
			onEvent: (event) => events.push(event),
			bridge,
		});
		await vi.waitFor(() => expect(listeners.size).toBe(1));

		emit({ type: "chunk", data: 'data: {"type":"tail","seq":9}' });
		emit({ type: "end" });

		await done;
		expect(events).toEqual([{ type: "tail", seq: 9 }]);
	});

	it("maps a 401-marked open failure to CloudCpAuthError", async () => {
		const { bridge } = makeBridge(async () => {
			// Electron flattens invoke rejections to a prefixed message string.
			throw new Error(
				"Error invoking remote method 'cloudCp:openStream': Error: CLOUD_CP_STREAM_ERROR 401 No AO Cloud session is available. Sign in and try again.",
			);
		});
		const onError = vi.fn();

		await subscribeSessionEventsBridged({
			baseUrl: BASE,
			orgId: "o1",
			sessionId: "s1",
			onEvent: () => undefined,
			onError,
			bridge,
		});

		expect(onError).toHaveBeenCalledTimes(1);
		const error = onError.mock.calls[0][0] as CloudCpError;
		expect(error).toBeInstanceOf(CloudCpAuthError);
		expect(error.status).toBe(401);
		expect(error.message).toContain("Sign in");
	});

	it("maps other marked open failures to CloudCpError with their status", async () => {
		const { bridge } = makeBridge(async () => {
			throw new Error("CLOUD_CP_STREAM_ERROR 404 session not found");
		});
		const onError = vi.fn();

		await subscribeSessionEventsBridged({
			baseUrl: BASE,
			orgId: "o1",
			sessionId: "s1",
			onEvent: () => undefined,
			onError,
			bridge,
		});

		const error = onError.mock.calls[0][0] as CloudCpError;
		expect(error).toBeInstanceOf(CloudCpError);
		expect(error).not.toBeInstanceOf(CloudCpAuthError);
		expect(error.status).toBe(404);
		expect(error.message).toBe("session not found");
	});

	it("maps unmarked open failures to a status-0 CloudCpError", async () => {
		const { bridge } = makeBridge(async () => {
			throw new Error("net::ERR_CONNECTION_REFUSED");
		});
		const onError = vi.fn();

		await subscribeSessionEventsBridged({
			baseUrl: BASE,
			orgId: "o1",
			sessionId: "s1",
			onEvent: () => undefined,
			onError,
			bridge,
		});

		const error = onError.mock.calls[0][0] as CloudCpError;
		expect(error.status).toBe(0);
		expect(error.message).toContain("ERR_CONNECTION_REFUSED");
	});

	it("reports a mid-stream error event and resolves", async () => {
		const { bridge, emit, listeners } = makeBridge();
		const onError = vi.fn();
		const done = subscribeSessionEventsBridged({
			baseUrl: BASE,
			orgId: "o1",
			sessionId: "s1",
			onEvent: () => undefined,
			onError,
			bridge,
		});
		await vi.waitFor(() => expect(listeners.size).toBe(1));

		emit({ type: "error", message: "connection reset" });

		await done;
		const error = onError.mock.calls[0][0] as CloudCpError;
		expect(error.message).toBe("connection reset");
		expect(listeners.size).toBe(0);
	});

	it("keeps the stream alive past a malformed-JSON frame", async () => {
		const { bridge, emit, listeners } = makeBridge();
		const events: CloudCpClientEvent[] = [];
		const onError = vi.fn();
		const done = subscribeSessionEventsBridged({
			baseUrl: BASE,
			orgId: "o1",
			sessionId: "s1",
			onEvent: (event) => events.push(event),
			onError,
			bridge,
		});
		await vi.waitFor(() => expect(listeners.size).toBe(1));

		emit({ type: "chunk", data: "data: {not json\n\n" });
		emit({ type: "chunk", data: frame({ type: "ok", seq: 1 }) });
		emit({ type: "end" });

		await done;
		expect(onError).toHaveBeenCalledTimes(1);
		expect((onError.mock.calls[0][0] as CloudCpError).message).toMatch(/malformed JSON/);
		expect(events).toEqual([{ type: "ok", seq: 1 }]);
	});

	it("aborting closes the stream silently and resolves", async () => {
		const { bridge, emit, listeners } = makeBridge();
		const controller = new AbortController();
		const onError = vi.fn();
		const events: CloudCpClientEvent[] = [];

		const done = subscribeSessionEventsBridged({
			baseUrl: BASE,
			orgId: "o1",
			sessionId: "s1",
			onEvent: (event) => events.push(event),
			onError,
			signal: controller.signal,
			bridge,
		});
		await vi.waitFor(() => expect(listeners.size).toBe(1));

		controller.abort();
		emit({ type: "chunk", data: frame({ type: "late", seq: 1 }) });

		await done;
		expect(bridge.closeStream).toHaveBeenCalledWith("stream_1");
		expect(onError).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(listeners.size).toBe(0);
	});

	it("returns immediately when the signal is already aborted", async () => {
		const { bridge, openCalls } = makeBridge();
		const controller = new AbortController();
		controller.abort();

		await subscribeSessionEventsBridged({
			baseUrl: BASE,
			orgId: "o1",
			sessionId: "s1",
			onEvent: () => undefined,
			signal: controller.signal,
			bridge,
		});

		expect(openCalls).toHaveLength(0);
	});

	it("closes a stream that finished opening after an abort", async () => {
		let resolveOpen: ((value: { streamId: string }) => void) | undefined;
		const { bridge } = makeBridge(
			() =>
				new Promise<{ streamId: string }>((resolve) => {
					resolveOpen = resolve;
				}),
		);
		const controller = new AbortController();

		const done = subscribeSessionEventsBridged({
			baseUrl: BASE,
			orgId: "o1",
			sessionId: "s1",
			onEvent: () => undefined,
			signal: controller.signal,
			bridge,
		});
		await vi.waitFor(() => expect(resolveOpen).toBeDefined());
		controller.abort();
		resolveOpen?.({ streamId: "stream_1" });

		await done;
		expect(bridge.closeStream).toHaveBeenCalledWith("stream_1");
	});
});
