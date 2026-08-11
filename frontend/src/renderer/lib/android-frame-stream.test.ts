import { afterEach, describe, expect, it, vi } from "vitest";
import { createAndroidFrameStream } from "./android-frame-stream";

// Minimal fake socket, mirroring terminal-mux.test.ts's FakeSocket.
class FakeSocket {
	static instances: FakeSocket[] = [];
	binaryType = "";
	closed = false;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public url: string) {
		FakeSocket.instances.push(this);
	}
	close() {
		this.closed = true;
	}
}

describe("createAndroidFrameStream", () => {
	afterEach(() => {
		FakeSocket.instances = [];
	});

	it("connects to the given url in binary mode", () => {
		createAndroidFrameStream("ws://x/stream", vi.fn(), vi.fn(), FakeSocket as unknown as typeof WebSocket);
		const socket = FakeSocket.instances.at(-1)!;
		expect(socket.url).toBe("ws://x/stream");
		expect(socket.binaryType).toBe("arraybuffer");
	});

	it("forwards each binary message's payload to onFrame", () => {
		const onFrame = vi.fn();
		createAndroidFrameStream("ws://x/stream", onFrame, vi.fn(), FakeSocket as unknown as typeof WebSocket);
		const socket = FakeSocket.instances.at(-1)!;
		const bytes = new ArrayBuffer(4);
		socket.onmessage?.({ data: bytes });
		expect(onFrame).toHaveBeenCalledWith(bytes);
	});

	it("reports connection state via onConnectedChange", () => {
		const onConnectedChange = vi.fn();
		createAndroidFrameStream("ws://x/stream", vi.fn(), onConnectedChange, FakeSocket as unknown as typeof WebSocket);
		const socket = FakeSocket.instances.at(-1)!;
		socket.onopen?.();
		expect(onConnectedChange).toHaveBeenCalledWith(true);
		socket.onclose?.();
		expect(onConnectedChange).toHaveBeenCalledWith(false);
	});

	it("close() closes the underlying socket", () => {
		const stream = createAndroidFrameStream("ws://x/stream", vi.fn(), vi.fn(), FakeSocket as unknown as typeof WebSocket);
		const socket = FakeSocket.instances.at(-1)!;
		stream.close();
		expect(socket.closed).toBe(true);
	});
});
