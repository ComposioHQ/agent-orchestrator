import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_HOST_ID, useRemoteHosts } from "./useRemoteHosts";
import { useUiStore } from "../stores/ui-store";

const { listMock, probeMock } = vi.hoisted(() => ({
	listMock: vi.fn(),
	probeMock: vi.fn(),
}));

// The bridge's `remotes` surface lands with the IPC task; mock the module
// rather than spying on a stub that does not exist yet.
vi.mock("../lib/bridge", () => ({
	aoBridge: { remotes: { list: listMock, probe: probeMock } },
}));

beforeEach(() => {
	listMock.mockClear();
	probeMock.mockClear();
	listMock.mockResolvedValue([{ label: "workbox", url: "http://192.0.2.1:3011" }]);
	probeMock.mockResolvedValue("online");
	useUiStore.setState({ remoteHosts: true });
});

describe("useRemoteHosts with the Remote hosts flag off", () => {
	it("lists only the local host and contacts no saved host", async () => {
		useUiStore.setState({ remoteHosts: false });
		const { result } = renderHook(() => useRemoteHosts());

		await result.current.refresh();

		expect(result.current.hosts.map((host) => host.id)).toEqual([LOCAL_HOST_ID]);
		expect(listMock).not.toHaveBeenCalled();
		expect(probeMock).not.toHaveBeenCalled();
	});
});

describe("useRemoteHosts", () => {
	it("always lists the local host first, before any remote resolves", () => {
		const { result } = renderHook(() => useRemoteHosts());
		expect(result.current.hosts[0]).toMatchObject({ id: LOCAL_HOST_ID, url: null, status: "local" });
	});

	it("appends saved hosts and probes each one", async () => {
		const { result } = renderHook(() => useRemoteHosts());
		await waitFor(() => expect(result.current.hosts).toHaveLength(2));
		await waitFor(() => expect(result.current.hosts[1]).toMatchObject({ label: "workbox", status: "online" }));
	});

	it("surfaces an unreachable host as offline rather than hiding it", async () => {
		probeMock.mockResolvedValue("offline");
		const { result } = renderHook(() => useRemoteHosts());
		await waitFor(() => expect(result.current.hosts[1]?.status).toBe("offline"));
	});

	it("keeps the local host when the bridge has no remotes at all", async () => {
		listMock.mockResolvedValue([]);
		const { result } = renderHook(() => useRemoteHosts());
		await waitFor(() => expect(result.current.hosts).toEqual([expect.objectContaining({ id: LOCAL_HOST_ID })]));
	});
});
