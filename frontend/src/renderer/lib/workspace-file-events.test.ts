import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getApiBaseUrlMock, hasTrustedApiBaseUrlMock, subscribeApiBaseUrlMock, unsubscribeBaseUrlMock } = vi.hoisted(
	() => ({
		getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:3001"),
		hasTrustedApiBaseUrlMock: vi.fn(() => true),
		subscribeApiBaseUrlMock: vi.fn(),
		unsubscribeBaseUrlMock: vi.fn(),
	}),
);

vi.mock("./api-client", () => ({
	getApiBaseUrl: getApiBaseUrlMock,
	hasTrustedApiBaseUrl: hasTrustedApiBaseUrlMock,
	subscribeApiBaseUrl: subscribeApiBaseUrlMock,
}));

import { subscribeWorkspaceFileChanges } from "./workspace-file-events";

// A manually-driven readable-stream body: the test pushes SSE text and ends it.
function makeStreamBody() {
	const encoder = new TextEncoder();
	const queued: Uint8Array[] = [];
	let waiting: ((r: { value?: Uint8Array; done: boolean }) => void) | null = null;
	let ended = false;
	return {
		push(text: string) {
			const chunk = encoder.encode(text);
			if (waiting) {
				const resolve = waiting;
				waiting = null;
				resolve({ value: chunk, done: false });
			} else {
				queued.push(chunk);
			}
		},
		end() {
			ended = true;
			if (waiting) {
				const resolve = waiting;
				waiting = null;
				resolve({ value: undefined, done: true });
			}
		},
		body: {
			getReader() {
				return {
					read: () =>
						new Promise<{ value?: Uint8Array; done: boolean }>((resolve) => {
							if (queued.length) return resolve({ value: queued.shift(), done: false });
							if (ended) return resolve({ value: undefined, done: true });
							waiting = resolve;
						}),
					cancel: () => {},
				};
			},
		},
	};
}

function response(status: number, body: unknown = null, headers: Record<string, string> = {}): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		body,
		headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
	} as unknown as Response;
}

function fakeQueryClient() {
	return { invalidateQueries: vi.fn() } as unknown as Parameters<typeof subscribeWorkspaceFileChanges>[1];
}

let fetchMock: ReturnType<typeof vi.fn>;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	getApiBaseUrlMock.mockReset().mockReturnValue("http://127.0.0.1:3001");
	hasTrustedApiBaseUrlMock.mockReset().mockReturnValue(true);
	subscribeApiBaseUrlMock.mockReset().mockReturnValue(unsubscribeBaseUrlMock);
	unsubscribeBaseUrlMock.mockReset();
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("subscribeWorkspaceFileChanges", () => {
	it("opens one stream shared across views and aborts it on the final unmount", async () => {
		const stream = makeStreamBody();
		fetchMock.mockResolvedValue(response(200, stream.body));
		const queryClient = fakeQueryClient();

		const unsubA = subscribeWorkspaceFileChanges("session/a", queryClient);
		const unsubB = subscribeWorkspaceFileChanges("session/a", queryClient);
		await flush();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://127.0.0.1:3001/api/v1/sessions/session%2Fa/workspace/events");
		const signal = (init as RequestInit).signal as AbortSignal;

		unsubA();
		expect(signal.aborted).toBe(false); // still referenced by view B
		unsubB();
		expect(signal.aborted).toBe(true); // last view gone -> stream aborted
		expect(unsubscribeBaseUrlMock).toHaveBeenCalledTimes(1);
	});

	it("coalesces workspace_changed events into one debounced invalidation", async () => {
		const stream = makeStreamBody();
		fetchMock.mockResolvedValue(response(200, stream.body));
		const queryClient = fakeQueryClient();

		const unsub = subscribeWorkspaceFileChanges("sess-1", queryClient);
		await flush(); // let fetch resolve and the read loop start
		stream.push("event: workspace_changed\ndata: {}\n\n");
		stream.push("event: workspace_changed\ndata: {}\n\n");
		await flush();
		await new Promise((r) => setTimeout(r, 200)); // debounce (150ms) elapses

		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-workspace-files", "sess-1"] });
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-workspace-file", "sess-1"] });
		unsub();
	});

	it("stops (does not reconnect) on a 4xx — session/workspace gone", async () => {
		vi.useFakeTimers();
		fetchMock.mockResolvedValue(response(404, null));
		const queryClient = fakeQueryClient();

		const unsub = subscribeWorkspaceFileChanges("gone", queryClient);
		await vi.advanceTimersByTimeAsync(0); // resolve the 404
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(120_000); // well past any backoff window
		expect(fetchMock).toHaveBeenCalledTimes(1); // never retried
		unsub();
	});

	it("backs off and reconnects on a 5xx", async () => {
		vi.useFakeTimers();
		fetchMock.mockResolvedValue(response(500, null));
		const queryClient = fakeQueryClient();

		const unsub = subscribeWorkspaceFileChanges("busy", queryClient);
		await vi.advanceTimersByTimeAsync(0); // resolve the first 500
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000); // exceed the max backoff step
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); // retried
		unsub();
	});
});
