// The terminal pane is shared between local and cloud sessions; only the socket
// underneath differs. These cases pin that routing decision to the SESSION's own
// location, so a local and a cloud attachment can coexist in one window and no
// shared API base URL is ever swapped.

import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createTerminalMuxMock, createCloudTerminalMuxMock, cloudClientForMock, getApiBaseUrlMock } = vi.hoisted(() => ({
	createTerminalMuxMock: vi.fn(),
	createCloudTerminalMuxMock: vi.fn(),
	cloudClientForMock: vi.fn(),
	getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:4317"),
}));

function stubMux() {
	return {
		open: vi.fn(),
		sendInput: vi.fn(),
		resize: vi.fn(),
		close: vi.fn(),
		onData: vi.fn(() => () => undefined),
		onExit: vi.fn(() => () => undefined),
		onOpened: vi.fn(() => () => undefined),
		onError: vi.fn(() => () => undefined),
		onConnectionChange: vi.fn(() => () => undefined),
		dispose: vi.fn(),
	};
}

vi.mock("../lib/terminal-mux", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/terminal-mux")>();
	return { ...actual, createTerminalMux: createTerminalMuxMock };
});

vi.mock("../lib/cloud-terminal-mux", () => ({ createCloudTerminalMux: createCloudTerminalMuxMock }));
vi.mock("../lib/cloud-api", () => ({ cloudClientFor: cloudClientForMock }));
vi.mock("../lib/api-client", () => ({ getApiBaseUrl: getApiBaseUrlMock }));
vi.mock("../lib/telemetry", () => ({ captureRendererEvent: vi.fn().mockResolvedValue(undefined) }));

import { useTerminalSession } from "./useTerminalSession";
import { useCloudStore } from "../stores/cloud-store";
import type { WorkspaceSession } from "../types/workspace";

function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function terminal() {
	return {
		cols: 80,
		rows: 24,
		write: vi.fn(),
		writeln: vi.fn(),
		showLatestOutput: vi.fn(),
		prepareForActivation: vi.fn().mockResolvedValue(undefined),
		onUserInput: vi.fn(() => ({ dispose: vi.fn() })),
		onResize: vi.fn(() => ({ dispose: vi.fn() })),
	};
}

const baseSession = {
	workspaceName: "Project",
	title: "task",
	provider: "claude-code",
	kind: "worker",
	status: "working",
	updatedAt: "2026-08-22T00:00:00Z",
	prs: [],
} satisfies Partial<WorkspaceSession>;

const localSession: WorkspaceSession = {
	...baseSession,
	id: "local-1",
	workspaceId: "proj-1",
	terminalHandleId: "handle-local",
};

const cloudSession: WorkspaceSession = {
	...baseSession,
	id: "cloud-1",
	workspaceId: "cloud-proj-1",
	location: "cloud",
	orgId: "org-1",
};

function attach(session: WorkspaceSession) {
	const { result } = renderHook(() => useTerminalSession(session, { daemonReady: true }), { wrapper });
	result.current.attach(terminal());
}

describe("terminal transport routing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		createTerminalMuxMock.mockImplementation(() => stubMux());
		createCloudTerminalMuxMock.mockImplementation(() => stubMux());
		cloudClientForMock.mockReturnValue({ id: "cloud-client" });
		useCloudStore.setState({
			availability: { available: true, enabled: true, apiBaseUrl: "https://cloud.example" },
			account: null,
			loaded: true,
			accountLoaded: true,
			saving: false,
			saveError: false,
		});
	});

	it("attaches a local session to the loopback daemon mux", () => {
		attach(localSession);

		expect(createTerminalMuxMock).toHaveBeenCalledWith("ws://127.0.0.1:4317/mux");
		expect(createCloudTerminalMuxMock).not.toHaveBeenCalled();
	});

	it("attaches a cloud session to the control-plane relay for its own organization", () => {
		attach(cloudSession);

		expect(createCloudTerminalMuxMock).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-1", sessionId: "cloud-1", client: { id: "cloud-client" } }),
		);
		expect(createTerminalMuxMock).not.toHaveBeenCalled();
		// The loopback base URL is never consulted for a cloud attachment, and
		// nothing swapped it — the local mux would still get the daemon port.
		expect(cloudClientForMock).toHaveBeenCalledWith("https://cloud.example");
	});

	it("keeps both transports live at once, one per session", () => {
		attach(localSession);
		attach(cloudSession);

		expect(createTerminalMuxMock).toHaveBeenCalledTimes(1);
		expect(createCloudTerminalMuxMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to the local mux when a cloud session has no organization to route to", () => {
		attach({ ...cloudSession, orgId: undefined });

		expect(createCloudTerminalMuxMock).not.toHaveBeenCalled();
		expect(createTerminalMuxMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to the local mux when no cloud client can be built", () => {
		cloudClientForMock.mockReturnValue(null);

		attach(cloudSession);

		expect(createCloudTerminalMuxMock).not.toHaveBeenCalled();
		expect(createTerminalMuxMock).toHaveBeenCalledTimes(1);
	});

	it("does not attach a cloud session that has no id-derived handle path", () => {
		// A local session with no runtime handle stays idle; the cloud branch must
		// not manufacture one for it.
		attach({ ...localSession, terminalHandleId: undefined });

		expect(createTerminalMuxMock).not.toHaveBeenCalled();
		expect(createCloudTerminalMuxMock).not.toHaveBeenCalled();
	});
});
