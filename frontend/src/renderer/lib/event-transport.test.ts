import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSseRetryDelayMs } from "./sse-backoff";

const {
	onStatusMock,
	removeStatusMock,
	getApiBaseUrlMock,
	hasTrustedApiBaseUrlMock,
	subscribeApiBaseUrlMock,
	unsubscribeBaseUrlMock,
	setTransportHealthyMock,
} = vi.hoisted(() => ({
	onStatusMock: vi.fn(),
	removeStatusMock: vi.fn(),
	getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:3001"),
	hasTrustedApiBaseUrlMock: vi.fn(() => true),
	subscribeApiBaseUrlMock: vi.fn(),
	unsubscribeBaseUrlMock: vi.fn(),
	setTransportHealthyMock: vi.fn(),
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
vi.mock("./agent-switch-visibility", () => ({ agentSwitchVisibility: { setTransportHealthy: setTransportHealthyMock } }));

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
		this.handlers.get(type)?.({ data } as unknown as Event);
	}
	close() {
		this.closed = true;
		this.readyState = 2; // CLOSED
	}
}

function fakeQueryClient() {
	return {
		invalidateQueries: vi.fn(),
		refetchQueries: vi.fn().mockResolvedValue(undefined),
		setQueryData: vi.fn(),
	} as unknown as Parameters<typeof createEventTransport>[0];
}

function cdcSources() {
	return EventSourceStub.instances.filter((source) => source.url.endsWith("/api/v1/events"));
}

function accountSources() {
	return EventSourceStub.instances.filter((source) => source.url.endsWith("/agents/codex/accounts/events"));
}

function claudeAccountSources() {
	return EventSourceStub.instances.filter((source) => source.url.endsWith("/agents/claude-code/accounts/events"));
}

beforeEach(() => {
	EventSourceStub.instances = [];
	onStatusMock.mockReset().mockReturnValue(removeStatusMock);
	removeStatusMock.mockReset();
	getApiBaseUrlMock.mockReset().mockReturnValue("http://127.0.0.1:3001");
	hasTrustedApiBaseUrlMock.mockReset().mockReturnValue(true);
	subscribeApiBaseUrlMock.mockReset().mockReturnValue(unsubscribeBaseUrlMock);
	unsubscribeBaseUrlMock.mockReset();
	setTransportHealthyMock.mockReset();
	setEventsConnectionState("idle");
	(globalThis as unknown as { EventSource: unknown }).EventSource = EventSourceStub;
});

afterEach(() => {
	delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("createEventTransport", () => {
	it("opens the CDC, Codex, and Claude Code account SSE connections on connect", () => {
		createEventTransport(fakeQueryClient()).connect();

		expect(EventSourceStub.instances).toHaveLength(3);
		expect(cdcSources()).toHaveLength(1);
		expect(accountSources()).toHaveLength(1);
		expect(claudeAccountSources()).toHaveLength(1);
		expect(cdcSources()[0].url).toBe("http://127.0.0.1:3001/api/v1/events");
		expect(accountSources()[0].url).toBe("http://127.0.0.1:3001/api/v1/agents/codex/accounts/events");
		expect(claudeAccountSources()[0].url).toBe("http://127.0.0.1:3001/api/v1/agents/claude-code/accounts/events");
		// All CDC event types plus onmessage are wired up.
		expect(cdcSources()[0].listeners).toContain("session_updated");
		expect(cdcSources()[0].listeners).toContain("review_run_created");
		expect(cdcSources()[0].listeners).toContain("review_run_updated");
		expect(cdcSources()[0].onmessage).toBeTypeOf("function");
		expect(accountSources()[0].listeners).toContain("codex_account");
		expect(claudeAccountSources()[0].listeners).toContain("claude_code_account");
	});

	it("does not reconnect when a daemon status keeps the same base URL", () => {
		createEventTransport(fakeQueryClient()).connect();
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		onStatusHandler();

		expect(EventSourceStub.instances).toHaveLength(3);
	});

	it("closes the old connection and reconnects when the base URL changes", () => {
		createEventTransport(fakeQueryClient()).connect();
		const first = cdcSources()[0];
		const firstAccount = accountSources()[0];
		const firstClaudeAccount = claudeAccountSources()[0];
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:3099");
		onStatusHandler();

		expect(first.closed).toBe(true);
		expect(firstAccount.closed).toBe(true);
		expect(firstClaudeAccount.closed).toBe(true);
		expect(cdcSources()).toHaveLength(2);
		expect(accountSources()).toHaveLength(2);
		expect(claudeAccountSources()).toHaveLength(2);
		expect(cdcSources()[1].url).toBe("http://127.0.0.1:3099/api/v1/events");
		expect(claudeAccountSources()[1].url).toBe(
			"http://127.0.0.1:3099/api/v1/agents/claude-code/accounts/events",
		);
	});

	it("does not make a new daemon port serve the dead port's backoff delay", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		createEventTransport(fakeQueryClient()).connect();
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		// Fail the old port repeatedly so the delay grows well past the initial step.
		for (let failure = 1; failure <= 4; failure += 1) {
			const source = EventSourceStub.instances.at(-1)!;
			source.readyState = 2;
			source.onerror?.();
			vi.advanceTimersByTime(computeSseRetryDelayMs(failure, () => 0.5));
		}
		const beforeCdcMove = cdcSources().length;
		const beforeAccountMove = accountSources().length;
		const beforeClaudeAccountMove = claudeAccountSources().length;

		// The daemon comes back on a different port: a fresh target.
		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:3099");
		onStatusHandler();
		expect(cdcSources()).toHaveLength(beforeCdcMove + 1);
		expect(accountSources()).toHaveLength(beforeAccountMove + 1);
		expect(claudeAccountSources()).toHaveLength(beforeClaudeAccountMove + 1);

		const moved = cdcSources().at(-1)!;
		moved.readyState = 2;
		moved.onerror?.();
		const firstRetryMs = computeSseRetryDelayMs(1, () => 0.5);
		const beforeRetry = EventSourceStub.instances.length;
		vi.advanceTimersByTime(firstRetryMs - 1);
		expect(EventSourceStub.instances).toHaveLength(beforeRetry);
		vi.advanceTimersByTime(1);
		expect(EventSourceStub.instances).toHaveLength(beforeRetry + 1);
		vi.useRealTimers();
	});

	it("closes the source and skips reconnecting when the base URL is untrusted", () => {
		createEventTransport(fakeQueryClient()).connect();
		const first = cdcSources()[0];
		const firstAccount = accountSources()[0];
		const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

		hasTrustedApiBaseUrlMock.mockReturnValue(false);
		onStatusHandler();

		expect(first.closed).toBe(true);
		expect(firstAccount.closed).toBe(true);
		expect(EventSourceStub.instances).toHaveLength(3);
		expect(getEventsConnectionState()).toBe("disconnected");
		expect(setTransportHealthyMock).toHaveBeenCalledWith("active", false);
		expect(setTransportHealthyMock).toHaveBeenCalledWith("history", false);
	});

	it("debounces workspace and session invalidation after a status change", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			const onStatusHandler = onStatusMock.mock.calls[0][0] as () => void;

			onStatusHandler();
			expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
			vi.advanceTimersByTime(200);
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-agent-switches"] });
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-scm-summary"] });
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-usage"] });
		} finally {
			vi.useRealTimers();
		}
	});

	// A reconnect resumes via Last-Event-ID. When the event log has been truncated
	// or replaced, that cursor is ahead of head and the daemon starts the client at
	// head instead of replaying — correct, but it means no conversation CDC arrives
	// to invalidate an open chat. EventSource cannot read the response header that
	// reports the clamp, so reopening must refresh conversations unconditionally.
	it("refreshes open conversations on reopen, not just workspaces", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			cdcSources()[0].onopen?.();

			vi.advanceTimersByTime(200);

			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["conversation"] });
		} finally {
			vi.useRealTimers();
		}
	});

	it("invalidates only the named conversation for conversation CDC", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			cdcSources()[0].emit(
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

	it("invalidates the named interface transition status for transition CDC", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			cdcSources()[0].emit(
				"session_updated",
				JSON.stringify({
					seq: 43,
					projectId: "proj-1",
					sessionId: "session-1",
					type: "session_updated",
					payload: {
						id: "session-1",
						interfaceTransitionId: "transition-1",
						interfaceTransitionPhase: "recovery_required",
					},
					createdAt: "2026-08-13T08:00:00Z",
				}),
			);

			vi.advanceTimersByTime(200);
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["session-interface-transition", "session-1"],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("normalizes account stream snapshots without invalidating workspaces", () => {
		let cached: unknown;
		const queryClient = {
			invalidateQueries: vi.fn(),
			setQueryData: vi.fn((_key: readonly string[], update: unknown) => {
				cached = typeof update === "function" ? update(undefined) : update;
			}),
		} as unknown as Parameters<typeof createEventTransport>[0];
		createEventTransport(queryClient).connect();

		accountSources()[0].emit("codex_account", JSON.stringify({
			activeAccountId: "account-1",
			accountRevision: 2,
			accounts: [{ id: "account-1", active: true }],
			capabilities: {},
		}));

		expect(cached).toMatchObject({ activeAccountId: "account-1", accountRevision: 2 });
		expect(cached).toMatchObject({ accounts: [{ id: "account-1", active: true }] });
		expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspaces"] });
	});

	it("normalizes Claude Code account stream snapshots in their own cache", () => {
		let cached: unknown;
		const queryClient = {
			invalidateQueries: vi.fn(),
			setQueryData: vi.fn((_key: readonly string[], update: unknown) => {
				cached = typeof update === "function" ? update(undefined) : update;
			}),
		} as unknown as Parameters<typeof createEventTransport>[0];
		createEventTransport(queryClient).connect();

		claudeAccountSources()[0].emit("claude_code_account", JSON.stringify({
			activeAccountId: "account-2",
			accountRevision: 4,
			accounts: [{ id: "account-2", active: true, createdAt: "2026-09-02T00:00:00Z" }],
			capabilities: {},
		}));

		expect(cached).toMatchObject({ activeAccountId: "account-2", accountRevision: 4 });
		expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspaces"] });
	});

	it("keeps account stream open and CDC invalidation within their own cache domains", () => {
		vi.useFakeTimers();
		try {
			const queryClient = fakeQueryClient();
			createEventTransport(queryClient).connect();
			accountSources()[0].onopen?.();
			expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["codex-accounts"] });
			expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspaces"] });

			vi.mocked(queryClient.invalidateQueries).mockClear();
			cdcSources()[0].emit("session_updated", JSON.stringify({ sessionId: "session-1", payload: {} }));
			vi.advanceTimersByTime(200);
			expect(queryClient.invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["codex-accounts"] });
		} finally {
			vi.useRealTimers();
		}
	});

	it("tears down the source and the daemon listener on disconnect", () => {
		const disconnect = createEventTransport(fakeQueryClient()).connect();

		disconnect();

		expect(cdcSources()[0].closed).toBe(true);
		expect(accountSources()[0].closed).toBe(true);
		expect(claudeAccountSources()[0].closed).toBe(true);
		expect(removeStatusMock).toHaveBeenCalledTimes(1);
	});

	it("is a no-op when EventSource is unavailable", () => {
		delete (globalThis as unknown as { EventSource?: unknown }).EventSource;

		expect(() => createEventTransport(fakeQueryClient()).connect()).not.toThrow();
		expect(EventSourceStub.instances).toHaveLength(0);
	});

	it("marks the stream connected on open and disconnected on error", () => {
		createEventTransport(fakeQueryClient()).connect();
		const source = cdcSources()[0];

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

	it("reports transport unhealthy only when the post-disconnect full refresh also fails", async () => {
		const queryClient = fakeQueryClient() as unknown as { refetchQueries: ReturnType<typeof vi.fn> };
		queryClient.refetchQueries = vi.fn().mockRejectedValue(new Error("refresh failed"));
		createEventTransport(queryClient as never).connect();
		const source = cdcSources()[0];
		source.onerror?.();
		expect(setTransportHealthyMock).not.toHaveBeenCalledWith("active", false);
		await Promise.resolve(); await Promise.resolve();
		expect(setTransportHealthyMock).toHaveBeenCalledWith("active", false);
		expect(setTransportHealthyMock).toHaveBeenCalledWith("history", false);
	});

	it("heals transport when the post-disconnect full refresh succeeds", async () => {
		const queryClient = fakeQueryClient() as unknown as { refetchQueries: ReturnType<typeof vi.fn> };
		queryClient.refetchQueries = vi.fn().mockResolvedValue(undefined);
		createEventTransport(queryClient as never).connect();
		cdcSources()[0].onerror?.();
		await Promise.resolve(); await Promise.resolve();
		expect(setTransportHealthyMock).toHaveBeenCalledWith("active", true);
		expect(setTransportHealthyMock).toHaveBeenCalledWith("history", true);
	});

	it("ignores a stale failed refresh after the SSE source reconnects", async () => {
		let rejectRefresh: (error: Error) => void = () => undefined;
		const queryClient = fakeQueryClient() as unknown as { refetchQueries: ReturnType<typeof vi.fn> };
		queryClient.refetchQueries = vi.fn().mockReturnValue(new Promise<void>((_resolve, reject) => { rejectRefresh = reject; }));
		createEventTransport(queryClient as never).connect();
		const source = cdcSources()[0];
		source.onerror?.();
		source.onopen?.();
		setTransportHealthyMock.mockClear();
		rejectRefresh(new Error("late failure"));
		await Promise.resolve(); await Promise.resolve();
		expect(setTransportHealthyMock).not.toHaveBeenCalledWith("active", false);
	});

	it("rebuilds a source the browser abandoned after the retry delay", () => {
		vi.useFakeTimers();
		try {
			createEventTransport(fakeQueryClient()).connect();
			const source = cdcSources()[0];

			source.readyState = 2; // CLOSED — EventSource gave up for good
			source.onerror?.();

			expect(cdcSources()).toHaveLength(1);
			vi.advanceTimersByTime(5_000);
			expect(cdcSources()).toHaveLength(2);
			expect(cdcSources()[1].url).toBe("http://127.0.0.1:3001/api/v1/events");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconnects when the API base URL changes out-of-band", () => {
		createEventTransport(fakeQueryClient()).connect();
		expect(subscribeApiBaseUrlMock).toHaveBeenCalledTimes(1);
		const onBaseUrlChange = subscribeApiBaseUrlMock.mock.calls[0][0] as () => void;
		const first = cdcSources()[0];
		const firstAccount = accountSources()[0];

		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:4555");
		onBaseUrlChange();

		expect(first.closed).toBe(true);
		expect(firstAccount.closed).toBe(true);
		expect(cdcSources()).toHaveLength(2);
		expect(accountSources()).toHaveLength(2);
		expect(cdcSources()[1].url).toBe("http://127.0.0.1:4555/api/v1/events");
	});

	it("resets the connection state and unsubscribes on disconnect", () => {
		const disconnect = createEventTransport(fakeQueryClient()).connect();
		const source = cdcSources()[0];
		source.readyState = 1;
		source.onopen?.();
		expect(getEventsConnectionState()).toBe("connected");

		disconnect();

		expect(getEventsConnectionState()).toBe("idle");
		expect(unsubscribeBaseUrlMock).toHaveBeenCalledTimes(1);
	});
});
