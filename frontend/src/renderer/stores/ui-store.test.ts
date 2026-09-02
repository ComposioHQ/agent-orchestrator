import { beforeEach, describe, expect, it, vi } from "vitest";
import { sidebarIsCompact, sidebarIsVisible, sidebarOccupiesLayout, useUiStore } from "./ui-store";

beforeEach(() => {
	window.localStorage.clear();
	vi.resetModules();
	useUiStore.setState({
		isSidebarOpen: true,
		isSidebarAutoCollapsed: false,
		sidebarAutoCollapseOverride: false,
		sidebarWorkspaceDemandPx: null,
	});
});

// A fresh module sees exactly what a booting renderer sees: only storage.
async function bootStore() {
	return (await import("./ui-store")).useUiStore;
}

describe("sidebar workspace pressure", () => {

	it("temporarily compacts navigation without changing the saved preference", () => {
		useUiStore.getState().setSidebarAutoCollapsed(true);

		const state = useUiStore.getState();
		expect(state.isSidebarOpen).toBe(true);
		expect(sidebarIsCompact(state)).toBe(true);
		expect(sidebarIsVisible(state)).toBe(false);
		expect(window.localStorage.getItem("ao.sidebar.open")).toBeNull();

		useUiStore.getState().setSidebarAutoCollapsed(false);
		expect(sidebarIsVisible(useUiStore.getState())).toBe(true);
	});

	it("returns a manually expanded sidebar to the compact rail under active pressure", () => {
		useUiStore.getState().setSidebarAutoCollapsed(true);
		useUiStore.getState().toggleSidebar();

		let state = useUiStore.getState();
		expect(state.isSidebarOpen).toBe(true);
		expect(state.sidebarAutoCollapseOverride).toBe(true);
		expect(sidebarIsVisible(state)).toBe(true);

		useUiStore.getState().toggleSidebar();
		state = useUiStore.getState();
		expect(state.isSidebarOpen).toBe(true);
		expect(sidebarIsCompact(state)).toBe(true);
		expect(sidebarOccupiesLayout(state)).toBe(true);
		expect(state.sidebarAutoCollapseOverride).toBe(false);
		expect(sidebarIsVisible(state)).toBe(false);
		expect(window.localStorage.getItem("ao.sidebar.open")).toBeNull();
	});

	it("does not revoke an explicit expansion when pressure fluctuates during motion", () => {
		useUiStore.getState().setSidebarAutoCollapsed(true);
		useUiStore.getState().toggleSidebar();
		useUiStore.getState().setSidebarAutoCollapsed(false);
		useUiStore.getState().setSidebarAutoCollapsed(true);

		let state = useUiStore.getState();
		expect(state.isSidebarAutoCollapsed).toBe(true);
		expect(state.sidebarAutoCollapseOverride).toBe(true);
		expect(sidebarIsVisible(state)).toBe(true);

		useUiStore.getState().clearSidebarAutoCollapse();

		state = useUiStore.getState();
		expect(state.isSidebarOpen).toBe(true);
		expect(state.sidebarAutoCollapseOverride).toBe(false);
		expect(sidebarIsVisible(state)).toBe(true);
	});
});


describe("remoteHosts flag", () => {
	it("is off until the user turns it on", async () => {
		expect((await bootStore()).getState().remoteHosts).toBe(false);
	});

	it("persists the switch so the choice survives a restart", () => {
		useUiStore.getState().setRemoteHosts(true);
		expect(useUiStore.getState().remoteHosts).toBe(true);
		expect(window.localStorage.getItem("ao.remoteHosts")).toBe("true");
		useUiStore.getState().setRemoteHosts(false);
	});

	it("reads a stored choice back at startup", async () => {
		window.localStorage.setItem("ao.remoteHosts", "true");
		expect((await bootStore()).getState().remoteHosts).toBe(true);
	});
});
