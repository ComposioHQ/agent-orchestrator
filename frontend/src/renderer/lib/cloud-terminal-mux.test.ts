import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudClient } from "@aoagents/cloud-client";
import { createCloudTerminalMux, resetCloudReplayCursors } from "./cloud-terminal-mux";
import { bytesToBase64 } from "./terminal-mux";

/** Minimal scriptable WebSocket: the mux only uses readyState/send/close/events. */
class FakeSocket {
	static instances: FakeSocket[] = [];
	static readonly OPEN = 1;

	readyState = 0;
	sent: string[] = [];
	private listeners = new Map<string, Set<(event: unknown) => void>>();

	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}

	addEventListener(type: string, listener: (event: unknown) => void) {
		const set = this.listeners.get(type) ?? new Set();
		set.add(listener);
		this.listeners.set(type, set);
	}

	send(frame: string) {
		this.sent.push(frame);
	}

	close() {
		this.readyState = 3;
	}

	emit(type: string, event: unknown = {}) {
		this.listeners.get(type)?.forEach((listener) => listener(event));
	}

	open() {
		this.readyState = FakeSocket.OPEN;
		this.emit("open");
	}

	message(frame: unknown) {
		this.emit("message", { data: JSON.stringify(frame) });
	}
}

function fakeClient(overrides: Partial<CloudClient> = {}): CloudClient {
	return {
		createTerminalTicket: vi.fn(async () => ({
			ticket: "tkt_1",
			expiresIn: 30,
			scopes: ["terminal:read", "terminal:operate"],
		})),
		terminalUrl: (ticket: string, options: { after?: number; kind?: string } = {}) =>
			`wss://cloud.example/api/cloud/v1/terminal?ticket=${ticket}&after=${options.after ?? 0}&kind=${options.kind ?? "workspace"}`,
		...overrides,
	} as unknown as CloudClient;
}

function makeMux(client: CloudClient = fakeClient()) {
	return createCloudTerminalMux({
		client,
		orgId: "org_1",
		sessionId: "sess_1",
		WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
	});
}

/** Let the ticket promise and the socket construction settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	FakeSocket.instances = [];
	resetCloudReplayCursors();
});

afterEach(() => {
	resetCloudReplayCursors();
});

describe("createCloudTerminalMux", () => {
	it("mints a session-scoped ticket and connects with it, never with the access token", async () => {
		const client = fakeClient();
		makeMux(client);
		await settle();

		expect(client.createTerminalTicket).toHaveBeenCalledWith("org_1", "sess_1", "workspace");
		const url = new URL(FakeSocket.instances[0]!.url);
		expect(url.protocol).toBe("wss:");
		expect(url.searchParams.get("ticket")).toBe("tkt_1");
		expect(url.searchParams.get("kind")).toBe("workspace");
		expect(url.searchParams.get("after")).toBe("0");
	});

	it("queues frames sent before the socket opens and flushes them in order", async () => {
		const mux = makeMux();
		mux.open("sess_1", 80, 24);
		mux.sendInput("sess_1", "ls\r");
		await settle();

		const socket = FakeSocket.instances[0]!;
		expect(socket.sent).toEqual([]);
		socket.open();

		expect(socket.sent.map((frame) => JSON.parse(frame).type)).toEqual(["open", "data"]);
	});

	it("delivers PTY bytes to the pane's listener", async () => {
		const mux = makeMux();
		const received: string[] = [];
		mux.onData("sess_1", (bytes) => received.push(new TextDecoder().decode(bytes)));
		await settle();
		FakeSocket.instances[0]!.open();

		FakeSocket.instances[0]!.message({
			ch: "terminal",
			type: "data",
			id: "sess_1",
			data: bytesToBase64(new TextEncoder().encode("hello")),
			seq: 7,
		});

		expect(received).toEqual(["hello"]);
	});

	it("resumes from the last delivered sequence after a reconnect", async () => {
		const client = fakeClient();
		const first = createCloudTerminalMux({
			client,
			orgId: "org_1",
			sessionId: "sess_1",
			WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
		});
		await settle();
		FakeSocket.instances[0]!.open();
		FakeSocket.instances[0]!.message({ ch: "terminal", type: "data", id: "sess_1", data: "", seq: 42 });
		first.dispose();

		createCloudTerminalMux({
			client,
			orgId: "org_1",
			sessionId: "sess_1",
			WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
		});
		await settle();

		expect(new URL(FakeSocket.instances[1]!.url).searchParams.get("after")).toBe("42");
	});

	it("restarts the replay from the top after the PTY exits", async () => {
		const client = fakeClient();
		const mux = makeMux(client);
		await settle();
		FakeSocket.instances[0]!.open();
		FakeSocket.instances[0]!.message({ ch: "terminal", type: "data", id: "sess_1", data: "", seq: 42 });
		FakeSocket.instances[0]!.message({ ch: "terminal", type: "exited", id: "sess_1" });
		mux.dispose();

		makeMux(client);
		await settle();

		expect(new URL(FakeSocket.instances[1]!.url).searchParams.get("after")).toBe("0");
	});

	it("reports exit and opened acks to the pane", async () => {
		const mux = makeMux();
		const events: string[] = [];
		mux.onOpened("sess_1", () => events.push("opened"));
		mux.onExit("sess_1", () => events.push("exited"));
		await settle();
		FakeSocket.instances[0]!.open();

		FakeSocket.instances[0]!.message({ ch: "terminal", type: "opened", id: "sess_1", seq: 0 });
		FakeSocket.instances[0]!.message({ ch: "terminal", type: "exited", id: "sess_1" });

		expect(events).toEqual(["opened", "exited"]);
	});

	it("refuses user input on a read-only ticket and says why", async () => {
		const client = fakeClient({
			createTerminalTicket: vi.fn(async () => ({ ticket: "tkt_ro", expiresIn: 30, scopes: ["terminal:read"] })),
		} as Partial<CloudClient>);
		const mux = makeMux(client);
		const errors: string[] = [];
		mux.onError("sess_1", (message) => errors.push(message));
		await settle();
		FakeSocket.instances[0]!.open();

		mux.sendInput("sess_1", "rm -rf /\r");
		mux.resize("sess_1", 120, 40);

		expect(FakeSocket.instances[0]!.sent).toEqual([]);
		expect(errors).toEqual(["This AO Cloud terminal is read-only.", "This AO Cloud terminal is read-only."]);
	});

	it("reports a failed ticket as a dropped connection so the attachment retries", async () => {
		const client = fakeClient({
			createTerminalTicket: vi.fn(async () => {
				throw new Error("ticket expired");
			}),
		} as Partial<CloudClient>);
		const mux = makeMux(client);
		const states: string[] = [];
		const errors: string[] = [];
		mux.onConnectionChange((state) => states.push(state));
		mux.onError("sess_1", (message) => errors.push(message));

		await settle();

		expect(FakeSocket.instances).toHaveLength(0);
		expect(states).toEqual(["closed"]);
		expect(errors).toEqual(["ticket expired"]);
	});

	it("stops delivering to a disposed attachment", async () => {
		const mux = makeMux();
		const received: string[] = [];
		mux.onData("sess_1", (bytes) => received.push(new TextDecoder().decode(bytes)));
		await settle();
		FakeSocket.instances[0]!.open();

		mux.dispose();
		FakeSocket.instances[0]!.message({
			ch: "terminal",
			type: "data",
			id: "sess_1",
			data: bytesToBase64(new TextEncoder().encode("late")),
		});

		expect(received).toEqual([]);
	});

	it("ignores frames from other channels and unparseable payloads", async () => {
		const mux = makeMux();
		const received: string[] = [];
		mux.onData("sess_1", (bytes) => received.push(new TextDecoder().decode(bytes)));
		await settle();
		FakeSocket.instances[0]!.open();

		FakeSocket.instances[0]!.emit("message", { data: "{not json" });
		FakeSocket.instances[0]!.message({ ch: "system", type: "pong" });

		expect(received).toEqual([]);
	});
});
