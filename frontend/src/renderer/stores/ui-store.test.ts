import { beforeEach, describe, expect, it } from "vitest";
import { sidebarIsVisible, sidebarOccupiesLayout, useUiStore } from "./ui-store";

describe("sidebar visibility", () => {
	beforeEach(() => {
		window.localStorage.clear();
		useUiStore.setState({
			browserSidebarAutoResizeAttempted: false,
			browserSidebarAutoResizeRequested: false,
			inspectorSessions: {},
			isSidebarOpen: true,
		});
	});

	it("requests the automatic sidebar resize only for the first Browser open in the app session", () => {
		useUiStore.getState().setInspectorView("session-1", "browser");
		expect(useUiStore.getState()).toMatchObject({
			browserSidebarAutoResizeAttempted: false,
			browserSidebarAutoResizeRequested: true,
		});

		useUiStore.getState().consumeBrowserSidebarAutoResize();
		useUiStore.getState().setInspectorView("session-1", "summary");
		useUiStore.getState().setInspectorView("session-2", "browser");

		expect(useUiStore.getState()).toMatchObject({
			browserSidebarAutoResizeAttempted: true,
			browserSidebarAutoResizeRequested: false,
		});
	});

	it("changes only through the explicit toggle and persists the preference", () => {
		useUiStore.getState().toggleSidebar();

		let state = useUiStore.getState();
		expect(state.isSidebarOpen).toBe(false);
		expect(sidebarIsVisible(state)).toBe(false);
		expect(sidebarOccupiesLayout(state)).toBe(false);
		expect(window.localStorage.getItem("ao.sidebar.open")).toBe("false");

		useUiStore.getState().toggleSidebar();
		state = useUiStore.getState();
		expect(state.isSidebarOpen).toBe(true);
		expect(sidebarIsVisible(state)).toBe(true);
		expect(sidebarOccupiesLayout(state)).toBe(true);
		expect(window.localStorage.getItem("ao.sidebar.open")).toBe("true");
	});
});
