import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	bridgeCapabilities,
	getStatusMock,
	onStatusMock,
	removeStatusMock,
	connectMock,
	stopTransportMock,
	setApiBaseUrlMock,
	setApiDaemonStatusMock,
} = vi.hoisted(() => ({
	bridgeCapabilities: { daemonControl: true },
	getStatusMock: vi.fn(),
	onStatusMock: vi.fn(),
	removeStatusMock: vi.fn(),
	connectMock: vi.fn(),
	stopTransportMock: vi.fn(),
	setApiBaseUrlMock: vi.fn(),
	setApiDaemonStatusMock: vi.fn(),
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		capabilities: bridgeCapabilities,
		daemon: { getStatus: getStatusMock, onStatus: onStatusMock },
	},
}));

vi.mock("../lib/event-transport", () => ({
	createEventTransport: vi.fn(() => ({ connect: connectMock })),
}));

vi.mock("../lib/api-client", () => ({
	setApiBaseUrl: setApiBaseUrlMock,
	setApiDaemonStatus: setApiDaemonStatusMock,
}));

import { useDaemonStatus } from "./useDaemonStatus";

type DaemonStatus = { state: "starting" | "ready" | "stopped" | "error"; port?: number; message?: string };

function fakeQueryClient(): QueryClient {
	return { invalidateQueries: vi.fn() } as unknown as QueryClient;
}

beforeEach(() => {
	vi.useRealTimers();
	bridgeCapabilities.daemonControl = true;
	getStatusMock.mockReset().mockResolvedValue({ state: "stopped" });
	onStatusMock.mockReset().mockReturnValue(removeStatusMock);
	removeStatusMock.mockReset();
	connectMock.mockReset().mockReturnValue(stopTransportMock);
	stopTransportMock.mockReset();
	setApiBaseUrlMock.mockReset();
	setApiDaemonStatusMock.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("useDaemonStatus", () => {
	it("reports web readiness from the same-origin health check", async () => {
		bridgeCapabilities.daemonControl = false;
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ status: "ok", service: "agent-orchestrator-daemon", pid: 4242 }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result } = renderHook(() => useDaemonStatus(fakeQueryClient()));

		const origin = new URL(window.location.origin);
		const port = Number(origin.port) || (origin.protocol === "https:" ? 443 : 80);
		await waitFor(() => expect(result.current).toMatchObject({ state: "ready", port, pid: 4242 }));
		expect(fetchMock).toHaveBeenCalledWith(new URL("/healthz", window.location.origin), {
			cache: "no-store",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
		});
		expect(setApiBaseUrlMock).toHaveBeenCalledWith(window.location.origin);
		expect(getStatusMock).not.toHaveBeenCalled();
		expect(onStatusMock).not.toHaveBeenCalled();
	});

	it("reports a web daemon outage plainly and keeps polling the web origin", async () => {
		bridgeCapabilities.daemonControl = false;
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

		const { result } = renderHook(() => useDaemonStatus(fakeQueryClient()));

		await waitFor(() => expect(result.current.code).toBe("daemon_unreachable"));
		expect(result.current.message).toBeUndefined();
		expect(setApiBaseUrlMock).toHaveBeenCalledWith(window.location.origin);
	});

	it("applies the initial status, points REST at the reported port, and connects the transport", async () => {
		getStatusMock.mockResolvedValue({ state: "ready", port: 3037 });
		const queryClient = fakeQueryClient();

		const { result } = renderHook(() => useDaemonStatus(queryClient));

		await waitFor(() => expect(result.current).toEqual({ state: "ready", port: 3037 }));
		expect(setApiBaseUrlMock).toHaveBeenCalledWith("http://127.0.0.1:3037");
		expect(connectMock).toHaveBeenCalledTimes(1);
		// Refetching is the (debounced) event transport's job — no direct invalidate.
		expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
	});

	it("quarantines the base URL for statuses without a port", async () => {
		getStatusMock.mockResolvedValue({ state: "stopped", message: "daemon not configured" });
		const queryClient = fakeQueryClient();

		const { result } = renderHook(() => useDaemonStatus(queryClient));

		await waitFor(() => expect(result.current.message).toBe("daemon not configured"));
		expect(setApiBaseUrlMock).toHaveBeenCalledWith(null);
	});

	it("quarantines REST for an incompatible daemon even when its port is known", async () => {
		getStatusMock.mockResolvedValue({ state: "error", port: 3001, message: "wrong daemon" });
		const queryClient = fakeQueryClient();

		const { result } = renderHook(() => useDaemonStatus(queryClient));

		await waitFor(() => expect(result.current).toEqual({ state: "error", port: 3001, message: "wrong daemon" }));
		expect(setApiBaseUrlMock).toHaveBeenCalledWith(null);
	});

	it("applies pushed status events from the bridge", async () => {
		const queryClient = fakeQueryClient();
		const { result } = renderHook(() => useDaemonStatus(queryClient));
		await waitFor(() => expect(onStatusMock).toHaveBeenCalled());
		const pushStatus = onStatusMock.mock.calls[0][0] as (status: DaemonStatus) => void;

		act(() => pushStatus({ state: "ready", port: 4555 }));

		expect(result.current).toEqual({ state: "ready", port: 4555 });
		expect(setApiBaseUrlMock).toHaveBeenCalledWith("http://127.0.0.1:4555");
	});

	it("refreshes non-ready status until the daemon is ready", async () => {
		vi.useFakeTimers();
		getStatusMock.mockResolvedValueOnce({ state: "starting" }).mockResolvedValueOnce({ state: "ready", port: 4777 });
		const queryClient = fakeQueryClient();

		const { result } = renderHook(() => useDaemonStatus(queryClient));

		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current).toEqual({ state: "starting" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});

		expect(result.current).toEqual({ state: "ready", port: 4777 });
		expect(getStatusMock).toHaveBeenCalledTimes(2);
		expect(setApiBaseUrlMock).toHaveBeenCalledWith("http://127.0.0.1:4777");
	});

	it("refreshes ready status so adopted daemon liveness is rechecked", async () => {
		vi.useFakeTimers();
		getStatusMock.mockResolvedValueOnce({ state: "ready", port: 4777 }).mockResolvedValueOnce({ state: "stopped" });
		const queryClient = fakeQueryClient();

		const { result } = renderHook(() => useDaemonStatus(queryClient));

		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current).toEqual({ state: "ready", port: 4777 });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});

		expect(result.current).toEqual({ state: "stopped" });
		expect(getStatusMock).toHaveBeenCalledTimes(2);
		expect(setApiBaseUrlMock).toHaveBeenCalledWith(null);
	});

	it("ignores stale refresh responses that complete after a newer refresh", async () => {
		let resolveFirst: (status: DaemonStatus) => void = () => undefined;
		getStatusMock
			.mockReturnValueOnce(
				new Promise<DaemonStatus>((resolve) => {
					resolveFirst = resolve;
				}),
			)
			.mockResolvedValueOnce({ state: "ready", port: 4777 });
		const queryClient = fakeQueryClient();

		const { result } = renderHook(() => useDaemonStatus(queryClient));

		act(() => window.dispatchEvent(new Event("focus")));
		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current).toEqual({ state: "ready", port: 4777 });

		await act(async () => {
			resolveFirst({ state: "stopped" });
			await Promise.resolve();
		});

		expect(result.current).toEqual({ state: "ready", port: 4777 });
		expect(setApiBaseUrlMock).toHaveBeenLastCalledWith("http://127.0.0.1:4777");
	});

	it("still connects the transport when the initial IPC status call fails", async () => {
		getStatusMock.mockRejectedValue(new Error("ipc unavailable"));
		const queryClient = fakeQueryClient();

		const { result } = renderHook(() => useDaemonStatus(queryClient));

		await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
		expect(result.current).toEqual({ state: "stopped" });
	});

	it("tears down the transport and the status listener on unmount", async () => {
		const queryClient = fakeQueryClient();
		const { unmount } = renderHook(() => useDaemonStatus(queryClient));
		await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));

		unmount();

		expect(stopTransportMock).toHaveBeenCalledTimes(1);
		expect(removeStatusMock).toHaveBeenCalledTimes(1);
	});
});
