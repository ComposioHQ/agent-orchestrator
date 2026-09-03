import { beforeEach, describe, expect, it } from "vitest";
import { sidebarIsCompact, sidebarIsVisible, sidebarOccupiesLayout, useUiStore } from "./ui-store";

describe("sidebar workspace pressure", () => {
	beforeEach(() => {
		window.localStorage.clear();
		useUiStore.setState({
			isSidebarOpen: true,
			isSidebarAutoCollapsed: false,
			sidebarAutoCollapseOverride: false,
			sidebarWorkspaceDemandPx: null,
		});
	});

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
