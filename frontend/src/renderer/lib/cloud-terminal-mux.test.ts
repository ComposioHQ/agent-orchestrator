import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudTerminalEvent } from "../../shared/cloud-beta";
import { createCloudTerminalMux } from "./cloud-terminal-mux";

const mocks = vi.hoisted(() => ({
	closeTerminal: vi.fn(),
	listener: null as ((event: CloudTerminalEvent) => void) | null,
	openTerminal: vi.fn().mockResolvedValue(undefined),
	resizeTerminal: vi.fn(),
	sendTerminalInput: vi.fn(),
	unsubscribe: vi.fn(),
}));

vi.mock("./bridge", () => ({
	aoBridge: {
		cloud: {
			closeTerminal: mocks.closeTerminal,
			onTerminalEvent: (listener: (event: CloudTerminalEvent) => void) => {
				mocks.listener = listener;
				return mocks.unsubscribe;
			},
			openTerminal: mocks.openTerminal,
			resizeTerminal: mocks.resizeTerminal,
			sendTerminalInput: mocks.sendTerminalInput,
		},
	},
}));

beforeEach(() => {
	mocks.closeTerminal.mockReset();
	mocks.listener = null;
	mocks.openTerminal.mockReset().mockResolvedValue(undefined);
	mocks.resizeTerminal.mockReset();
	mocks.sendTerminalInput.mockReset();
	mocks.unsubscribe.mockReset();
});

describe("createCloudTerminalMux", () => {
	it("forwards terminal frames through the credential-free Electron bridge", async () => {
		const mux = createCloudTerminalMux("org-1", "session-1");
		const data = vi.fn();
		const opened = vi.fn();
		const exited = vi.fn();
		const error = vi.fn();
		const connection = vi.fn();
		mux.onData("session-1", data);
		mux.onOpened("session-1", opened);
		mux.onExit("session-1", exited);
		mux.onError("session-1", error);
		mux.onConnectionChange(connection);

		mux.open("session-1", 120, 40);
		await vi.waitFor(() => expect(mocks.openTerminal).toHaveBeenCalledOnce());
		const input = mocks.openTerminal.mock.calls[0][0];
		expect(input).toMatchObject({ orgId: "org-1", sessionId: "session-1", kind: "agent", cols: 120, rows: 40 });
		expect(input).not.toHaveProperty("ticket");
		expect(input).not.toHaveProperty("accessToken");

		mocks.listener?.({ connectionId: input.connectionId, type: "connection", state: "open" });
		mocks.listener?.({ connectionId: input.connectionId, type: "opened" });
		mocks.listener?.({ connectionId: input.connectionId, type: "data", data: btoa("hello") });
		mocks.listener?.({ connectionId: input.connectionId, type: "error", message: "failed" });
		mocks.listener?.({ connectionId: input.connectionId, type: "exited" });

		expect(connection).toHaveBeenCalledWith("open");
		expect(opened).toHaveBeenCalledOnce();
		expect(new TextDecoder().decode(data.mock.calls[0][0])).toBe("hello");
		expect(error).toHaveBeenCalledWith("failed");
		expect(exited).toHaveBeenCalledOnce();

		mux.sendInput("session-1", "pwd\r");
		mux.resize("session-1", 100, 30);
		expect(mocks.sendTerminalInput).toHaveBeenCalledWith(input.connectionId, "pwd\r");
		expect(mocks.resizeTerminal).toHaveBeenCalledWith(input.connectionId, 100, 30);

		mux.dispose();
		expect(mocks.unsubscribe).toHaveBeenCalledOnce();
		expect(mocks.closeTerminal).toHaveBeenCalledWith(input.connectionId);
	});
});
