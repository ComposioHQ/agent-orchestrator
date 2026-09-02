import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiBaseUrl } from "./api-client";
import { forgetHost, registerHostBase } from "./host-clients";
import { LOCAL_HOST } from "./hosts";
import { closeAllHostStreams, hostConnectionState, syncHostStreams } from "./host-events";
import { reportHostStreamState } from "./host-telemetry";

vi.mock("./host-telemetry", () => ({ reportHostStreamState: vi.fn() }));

const reportStreamState = vi.mocked(reportHostStreamState);

const REMOTE = "http://192.0.2.1:3011";

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	listeners = new Map<string, () => void>();
	closed = false;
	constructor(readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, fn: () => void) {
		this.listeners.set(type, fn);
	}
	close() {
		this.closed = true;
	}
	emit(type: string) {
		this.listeners.get(type)?.();
	}
}

beforeEach(() => {
	setApiBaseUrl("http://127.0.0.1:3001");
	reportStreamState.mockClear();
});

afterEach(() => {
	closeAllHostStreams();
	forgetHost(REMOTE);
	setApiBaseUrl(null);
	FakeEventSource.instances = [];
	vi.unstubAllGlobals();
});

describe("host-events", () => {
	it("opens one stream per host, at each host's own base", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		syncHostStreams([LOCAL_HOST, REMOTE], vi.fn());
		expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
			expect.stringContaining("/api/v1/events"),
			"http://127.0.0.1:9999/tok/api/v1/events",
		]);
	});

	it("reports which host an event came from", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		const onEvent = vi.fn();
		syncHostStreams([LOCAL_HOST, REMOTE], onEvent);
		FakeEventSource.instances[1].emit("session_updated");
		expect(onEvent).toHaveBeenCalledWith(REMOTE);
		expect(onEvent).not.toHaveBeenCalledWith(LOCAL_HOST);
	});

	it("one host's stream failing leaves the others connected", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		syncHostStreams([LOCAL_HOST, REMOTE], vi.fn());
		FakeEventSource.instances[0].onopen?.();
		FakeEventSource.instances[1].onopen?.();
		FakeEventSource.instances[1].readyState = 2;
		FakeEventSource.instances[1].onerror?.();
		expect(hostConnectionState(LOCAL_HOST)).toBe("connected");
		expect(hostConnectionState(REMOTE)).toBe("disconnected");
	});

	it("dropping a host closes only its stream", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		syncHostStreams([LOCAL_HOST, REMOTE], vi.fn());
		syncHostStreams([LOCAL_HOST], vi.fn());
		expect(FakeEventSource.instances[1].closed).toBe(true);
		expect(FakeEventSource.instances[0].closed).toBe(false);
	});

	it("re-syncing the same hosts does not churn live streams", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		syncHostStreams([LOCAL_HOST], vi.fn());
		syncHostStreams([LOCAL_HOST], vi.fn());
		expect(FakeEventSource.instances).toHaveLength(1);
	});

	// A host that never opened a stream is not a host whose stream died: only
	// the second one means the board went stale, so only it may be reported.
	it("separates a host with no stream from one whose stream dropped", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		expect(hostConnectionState(REMOTE)).toBe("idle");

		syncHostStreams([REMOTE], vi.fn());
		FakeEventSource.instances[0].onopen?.();
		FakeEventSource.instances[0].readyState = 2;
		FakeEventSource.instances[0].onerror?.();
		expect(hostConnectionState(REMOTE)).toBe("disconnected");

		syncHostStreams([], vi.fn());
		expect(hostConnectionState(REMOTE)).toBe("idle");
	});

	it("reports one event per state change, counting the drops", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		syncHostStreams([REMOTE], vi.fn());
		const source = FakeEventSource.instances[0];

		source.onopen?.();
		source.readyState = 2;
		// EventSource fires onerror repeatedly while it retries; one drop is one drop.
		source.onerror?.();
		source.onerror?.();

		expect(reportStreamState.mock.calls).toEqual([
			[REMOTE, "connected", 0],
			[REMOTE, "disconnected", 1],
		]);
	});

	it("says nothing when a host is deliberately dropped", () => {
		vi.stubGlobal("EventSource", FakeEventSource);
		registerHostBase(REMOTE, "http://127.0.0.1:9999/tok");
		syncHostStreams([REMOTE], vi.fn());
		FakeEventSource.instances[0].onopen?.();
		reportStreamState.mockClear();

		syncHostStreams([], vi.fn());
		expect(reportStreamState).not.toHaveBeenCalled();
	});
});
