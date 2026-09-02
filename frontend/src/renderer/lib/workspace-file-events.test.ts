import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { baseUrlForMock, subscribeApiBaseUrlMock, subscribeConnectedHostsMock, unsubscribeBaseUrlMock } = vi.hoisted(
	() => ({
		baseUrlForMock: vi.fn(() => "http://127.0.0.1:3001"),
		subscribeApiBaseUrlMock: vi.fn(),
		subscribeConnectedHostsMock: vi.fn(),
		unsubscribeBaseUrlMock: vi.fn(),
	}),
);

vi.mock("./api-client", () => ({ subscribeApiBaseUrl: subscribeApiBaseUrlMock }));
vi.mock("./host-clients", () => ({
	baseUrlFor: baseUrlForMock,
	subscribeConnectedHosts: subscribeConnectedHostsMock,
}));

import { getWorkspaceFileConnectionState, subscribeWorkspaceFileChanges } from "./workspace-file-events";

let baseUrlListener: (() => void) | undefined;

const session = (id: string) => ({ host: "local", id });

class EventSourceStub {
	static instances: EventSourceStub[] = [];
	static throwNext = false;
	url: string;
	closed = false;
	readyState = 0;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	listeners = new Map<string, Set<() => void>>();

	constructor(url: string) {
		if (EventSourceStub.throwNext) {
			EventSourceStub.throwNext = false;
			throw new Error("connection setup failed");
		}
		this.url = url;
		EventSourceStub.instances.push(this);
	}

	addEventListener(type: string, listener: () => void) {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type: string) {
		for (const listener of this.listeners.get(type) ?? []) listener();
	}

	close() {
		this.closed = true;
		this.readyState = 2;
	}
}

function fakeQueryClient() {
	return { invalidateQueries: vi.fn() } as unknown as Parameters<typeof subscribeWorkspaceFileChanges>[1];
}

beforeEach(() => {
	EventSourceStub.instances = [];
	EventSourceStub.throwNext = false;
	baseUrlListener = undefined;
	baseUrlForMock.mockReset().mockReturnValue("http://127.0.0.1:3001");
	subscribeApiBaseUrlMock.mockReset().mockImplementation((listener: () => void) => {
		baseUrlListener = listener;
		return unsubscribeBaseUrlMock;
	});
	subscribeConnectedHostsMock.mockReset().mockReturnValue(unsubscribeBaseUrlMock);
	unsubscribeBaseUrlMock.mockReset();
	(globalThis as unknown as { EventSource: unknown }).EventSource = EventSourceStub;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("subscribeWorkspaceFileChanges", () => {
	it("shares one daemon stream until the final Files view unmounts", () => {
		const queryClient = fakeQueryClient();
		const unsubscribeRail = subscribeWorkspaceFileChanges(session("session/a"), queryClient);
		const unsubscribeMaximized = subscribeWorkspaceFileChanges(session("session/a"), queryClient);

		expect(EventSourceStub.instances).toHaveLength(1);
		expect(EventSourceStub.instances[0].url).toBe(
			"http://127.0.0.1:3001/api/v1/sessions/session%2Fa/workspace/events",
		);

		unsubscribeRail();
		expect(EventSourceStub.instances[0].closed).toBe(false);
		unsubscribeMaximized();
		expect(EventSourceStub.instances[0].closed).toBe(true);
		expect(unsubscribeBaseUrlMock).toHaveBeenCalledTimes(1);
	});

	it("coalesces filesystem events and invalidates the list plus visible details", () => {
		vi.useFakeTimers();
		const queryClient = fakeQueryClient();
		const unsubscribe = subscribeWorkspaceFileChanges(session("sess-1"), queryClient);
		const source = EventSourceStub.instances[0];

		source.dispatch("workspace_changed");
		source.dispatch("workspace_changed");
		vi.advanceTimersByTime(149);
		expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);

		expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(3);
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-workspace-files", "local:sess-1"] });
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-workspace-file", "local:sess-1"] });
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-workspace-tree", "local:sess-1"] });
		unsubscribe();
	});

	it("keeps one retry pending when another connect trigger arrives", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		EventSourceStub.throwNext = true;
		const unsubscribe = subscribeWorkspaceFileChanges(session("sess-retry"), fakeQueryClient());

		expect(EventSourceStub.instances).toHaveLength(0);
		baseUrlListener?.();
		expect(EventSourceStub.instances).toHaveLength(0);

		vi.advanceTimersByTime(4_999);
		expect(EventSourceStub.instances).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(EventSourceStub.instances).toHaveLength(1);
		unsubscribe();
	});

	it("reports degraded after three completed connection failures", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const unsubscribe = subscribeWorkspaceFileChanges(session("sess-degraded"), fakeQueryClient());

		for (let failure = 0; failure < 3; failure += 1) {
			const source = EventSourceStub.instances.at(-1)!;
			source.readyState = 2;
			source.onerror?.();
			if (failure < 2) vi.advanceTimersByTime(5_000);
		}

		expect(getWorkspaceFileConnectionState(session("sess-degraded"))).toBe("degraded");
		unsubscribe();
	});

	it("degrades after repeated native reconnect failures and recovers on open", () => {
		const unsubscribe = subscribeWorkspaceFileChanges(session("sess-native-retry"), fakeQueryClient());
		const source = EventSourceStub.instances[0];

		source.onopen?.();
		expect(getWorkspaceFileConnectionState(session("sess-native-retry"))).toBe("connected");

		source.readyState = 0;
		for (let failure = 0; failure < 3; failure += 1) {
			source.onerror?.();
			expect(getWorkspaceFileConnectionState(session("sess-native-retry"))).toBe(failure < 2 ? "connecting" : "degraded");
		}

		source.onopen?.();
		expect(getWorkspaceFileConnectionState(session("sess-native-retry"))).toBe("connected");
		unsubscribe();
	});

	it("uses a remote host's proxy base and distinct cache key", () => {
		baseUrlForMock.mockImplementation((...args: unknown[]) =>
			args[0] === "https://remote.example" ? "http://127.0.0.1:43123" : "http://127.0.0.1:3001",
		);
		const remote = { host: "https://remote.example", id: "sess-1" };
		const unsubscribe = subscribeWorkspaceFileChanges(remote, fakeQueryClient());

		expect(EventSourceStub.instances[0].url).toBe(
			"http://127.0.0.1:43123/api/v1/sessions/sess-1/workspace/events",
		);
		expect(subscribeApiBaseUrlMock).not.toHaveBeenCalled();
		expect(subscribeConnectedHostsMock).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("uses degraded polling when EventSource is unavailable", () => {
		delete (globalThis as unknown as { EventSource?: unknown }).EventSource;

		const unsubscribe = subscribeWorkspaceFileChanges(session("sess-no-eventsource"), fakeQueryClient());

		expect(getWorkspaceFileConnectionState(session("sess-no-eventsource"))).toBe("degraded");
		unsubscribe();
	});
});
