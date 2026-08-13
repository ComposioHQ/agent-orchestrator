import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	onStatusMock,
	removeStatusMock,
	getApiBaseUrlMock,
	hasTrustedApiBaseUrlMock,
	subscribeApiBaseUrlMock,
	unsubscribeBaseUrlMock,
} = vi.hoisted(() => ({
	onStatusMock: vi.fn(),
	removeStatusMock: vi.fn(),
	getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:3001"),
	hasTrustedApiBaseUrlMock: vi.fn(() => true),
	subscribeApiBaseUrlMock: vi.fn(),
	unsubscribeBaseUrlMock: vi.fn(),
}));

vi.mock("./bridge", () => ({
	aoBridge: {
		daemon: { onStatus: onStatusMock },
	},
}));

vi.mock("./api-client", () => ({
	getApiBaseUrl: getApiBaseUrlMock,
	hasTrustedApiBaseUrl: hasTrustedApiBaseUrlMock,
	subscribeApiBaseUrl: subscribeApiBaseUrlMock,
}));

import { createEventTransport } from "./event-transport";
import { getEventsConnectionState, setEventsConnectionState } from "./events-connection";

class EventSourceStub {
	static instances: EventSourceStub[] = [];
	url: string;
	closed = false;
	readyState = 0; // CONNECTING
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: (() => void) | null = null;
	listeners: string[] = [];
	handlers = new Map<string, (event: Event) => void>();
	constructor(url: string) {
		this.url = url;
		EventSourceStub.instances.push(this);
	}
	addEventListener(type: string, listener: (event: Event) => void) {
		this.listeners.push(type);
		this.handlers.set(type, listener);
	}
	emit(type: string, data: string) {
		this.handlers.get(type)?.({ type, data } as unknown as Event);
	}
	close() {
		this.closed = true;
		this.readyState = 2; // CLOSED
	}
}

function fakeQueryClient() {
	return { invalidateQueries: vi.fn() } as unknown as Parameters<typeof createEventTransport>[0];
}

beforeEach(() => {
	EventSourceStub.instances = [];
	onStatusMock.mockReset().mockReturnValue(removeStatusMock);
	removeStatusMock.mockReset();
	getApiBaseUrlMock.mockReset().mockReturnValue("http://127.0.0.1:3001");
	hasTrustedApiBaseUrlMock.mockReset().mockReturnValue(true);
	subscribeApiBaseUrlMock.mockReset().mockReturnValue(unsubscribeBaseUrlMock);
	unsubscribeBaseUrlMock.mockReset();
	setEventsConnectionState("idle");
	(globalThis as unknown as { EventSource: unknown }).EventSource = EventSourceStub;
});

afterEach(() => {
	delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("createEventTransport", () => {
	it("opens a single SSE connection to the current base URL on connect", () => {
		createEventTransport(fakeQueryClient()).connect();

		expect(EventSourceStub.instances).toHaveLength(1);
		expect(EventSourceStub.instances[0].url).toBe("http://127.0.0.1:3001/api/v1/events");
		// All CDC event types plus onmessage are wired up.
		expect(EventSourceStub.instances[0].listeners).toContain("session_updated");
		expect(EventSourceStub.instances[0].onmessage).toBeTypeOf("function");
	});

	it("does not reconnect when a daemon status keeps the same base URL", () => {
		createEventTransport(fakeQueryClient()).connect();
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		onStatusHandler();

		expect(EventSourceStub.instances).toHaveLength(1);
	});

	it("closes the old connection and reconnects when the base URL changes", () => {
		createEventTransport(fakeQueryClient()).connect();
		const first = EventSourceStub.instances[0];
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:3099");
		onStatusHandler();

		expect(first.closed).toBe(true);
		expect(EventSourceStub.instances).toHaveLength(2);
		expect(EventSourceStub.instances[1].url).toBe("http://127.0.0.1:3099/api/v1/events");
	});

	it("closes the source and skips reconnecting when the base URL is untrusted", () => {
		createEventTransport(fakeQueryClient()).connect();
		const first = EventSourceStub.instances[0];
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		hasTrustedApiBaseUrlMock.mockReturnValue(false);
		onStatusHandler();

		expect(first.closed).toBe(true);
		expect(EventSourceStub.instances).toHaveLength(1);
		expect(getEventsConnectionState()).toBe("disconnected");
	});

	it("debounces workspace and SCM summary invalidation after a status change", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

			onStatusHandler();
			expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
			vi.advanceTimersByTime(200);
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-scm-summary"] });
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-usage"] });
		} finally {
			vi.useRealTimers();
		}
	});

	it("routes a session_updated burst away from per-session SCM summaries and bounds the flush rate", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			const source = EventSourceStub.instances[0];

			// Live-measured shape: an active agent emits ~3 session_updated
			// events/second (usage-binding and activity CDC) with no PR changes.
			for (let i = 0; i < 20; i++) {
				source.emit(
					"session_updated",
					JSON.stringify({
						seq: i,
						projectId: "proj-1",
						sessionId: "sess-1",
						type: "session_updated",
						payload: { id: "sess-1" },
						createdAt: "2026-08-10T00:00:00Z",
					}),
				);
				vi.advanceTimersByTime(320);
			}
			vi.advanceTimersByTime(2_000);

			const calls = (queryClient.invalidateQueries as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
				(call[0] as { queryKey: readonly string[] }).queryKey.join("/"),
			);
			// No PR event arrived, so no per-session PR summary refetch at all.
			expect(calls.filter((key) => key.startsWith("session-scm-summary"))).toHaveLength(0);
			// Twenty events collapse into throttled workspace+usage rounds
			// (~1/second) instead of one round per event.
			const workspaceFlushes = calls.filter((key) => key === "workspaces").length;
			expect(workspaceFlushes).toBeGreaterThan(0);
			expect(workspaceFlushes).toBeLessThanOrEqual(8);
			expect(calls.filter((key) => key === "session-usage")).toHaveLength(workspaceFlushes);
		} finally {
			vi.useRealTimers();
		}
	});

	it("scopes PR events to the owning session's SCM summary without touching usage", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			EventSourceStub.instances[0].emit(
				"pr_updated",
				JSON.stringify({
					seq: 7,
					projectId: "proj-1",
					sessionId: "sess-9",
					type: "pr_updated",
					payload: { url: "https://github.com/x/y/pull/1" },
					createdAt: "2026-08-10T00:00:00Z",
				}),
			);

			vi.advanceTimersByTime(200);
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["session-scm-summary", "sess-9"],
			});
			expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
				queryKey: ["session-scm-summary"],
			});
			expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["session-usage"] });
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to the SCM summary root when a PR moves between sessions", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			EventSourceStub.instances[0].emit(
				"pr_session_changed",
				JSON.stringify({
					seq: 8,
					projectId: "proj-1",
					sessionId: "sess-2",
					type: "pr_session_changed",
					payload: { url: "https://github.com/x/y/pull/2" },
					createdAt: "2026-08-10T00:00:00Z",
				}),
			);

			vi.advanceTimersByTime(200);
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["session-scm-summary"],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes under a continuous sub-debounce event stream instead of starving", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			const source = EventSourceStub.instances[0];

			// 100 ms spacing never lets a plain trailing debounce fire.
			for (let i = 0; i < 50; i++) {
				source.emit(
					"session_updated",
					JSON.stringify({
						seq: i,
						projectId: "proj-1",
						sessionId: "sess-1",
						type: "session_updated",
						payload: { id: "sess-1" },
						createdAt: "2026-08-10T00:00:00Z",
					}),
				);
				vi.advanceTimersByTime(100);
			}

			const workspaceFlushes = (queryClient.invalidateQueries as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => (call[0] as { queryKey: readonly string[] }).queryKey.join("/") === "workspaces",
			).length;
			// 5 s of continuous events: flushed about once a second, not zero, not 50×.
			expect(workspaceFlushes).toBeGreaterThanOrEqual(4);
			expect(workspaceFlushes).toBeLessThanOrEqual(6);
		} finally {
			vi.useRealTimers();
		}
	});

	it("invalidates only the named conversation for conversation CDC", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			EventSourceStub.instances[0].emit(
				"session_updated",
				JSON.stringify({
					seq: 42,
					projectId: "proj-1",
					sessionId: "chat-1",
					type: "session_updated",
					payload: {
						id: "chat-1",
						sessionId: "chat-1",
						conversationId: "conv-1",
						activity: "active",
						isTerminated: false,
					},
					createdAt: "2026-08-04T15:15:14Z",
				}),
			);

			vi.advanceTimersByTime(200);
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["conversation", "chat-1"],
			});
			expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspaces"] });
			expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({
				queryKey: ["session-scm-summary"],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("tears down the source and the daemon listener on disconnect", () => {
		const disconnect = createEventTransport(fakeQueryClient()).connect();

		disconnect();

		expect(EventSourceStub.instances[0].closed).toBe(true);
		expect(removeStatusMock).toHaveBeenCalledTimes(1);
	});

	it("is a no-op when EventSource is unavailable", () => {
		delete (globalThis as unknown as { EventSource?: unknown }).EventSource;

		expect(() => createEventTransport(fakeQueryClient()).connect()).not.toThrow();
		expect(EventSourceStub.instances).toHaveLength(0);
	});

	it("marks the stream connected on open and disconnected on error", () => {
		createEventTransport(fakeQueryClient()).connect();
		const source = EventSourceStub.instances[0];

		source.readyState = 1; // OPEN
		source.onopen?.();
		expect(getEventsConnectionState()).toBe("connected");

		source.readyState = 0; // CONNECTING — browser is auto-retrying
		source.onerror?.();
		expect(getEventsConnectionState()).toBe("disconnected");

		source.readyState = 1;
		source.onopen?.();
		expect(getEventsConnectionState()).toBe("connected");
	});

	it("rebuilds a source the browser abandoned after the retry delay", () => {
		vi.useFakeTimers();
		try {
			createEventTransport(fakeQueryClient()).connect();
			const source = EventSourceStub.instances[0];

			source.readyState = 2; // CLOSED — EventSource gave up for good
			source.onerror?.();

			expect(EventSourceStub.instances).toHaveLength(1);
			vi.advanceTimersByTime(5_000);
			expect(EventSourceStub.instances).toHaveLength(2);
			expect(EventSourceStub.instances[1].url).toBe("http://127.0.0.1:3001/api/v1/events");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconnects when the API base URL changes out-of-band", () => {
		createEventTransport(fakeQueryClient()).connect();
		expect(subscribeApiBaseUrlMock).toHaveBeenCalledTimes(1);
		const onBaseUrlChange = subscribeApiBaseUrlMock.mock.calls[0][0] as () => void;
		const first = EventSourceStub.instances[0];

		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:4555");
		onBaseUrlChange();

		expect(first.closed).toBe(true);
		expect(EventSourceStub.instances).toHaveLength(2);
		expect(EventSourceStub.instances[1].url).toBe("http://127.0.0.1:4555/api/v1/events");
	});

	it("resets the connection state and unsubscribes on disconnect", () => {
		const disconnect = createEventTransport(fakeQueryClient()).connect();
		const source = EventSourceStub.instances[0];
		source.readyState = 1;
		source.onopen?.();
		expect(getEventsConnectionState()).toBe("connected");

		disconnect();

		expect(getEventsConnectionState()).toBe("idle");
		expect(unsubscribeBaseUrlMock).toHaveBeenCalledTimes(1);
	});
});
