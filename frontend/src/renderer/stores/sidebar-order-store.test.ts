import { beforeEach, describe, expect, it } from "vitest";
import {
	hydrateSidebarOrderFromStorage,
	readStoredSidebarOrder,
	useSidebarOrderStore,
} from "./sidebar-order-store";

const storageKey = "ao.sidebar.order";

function stored() {
	return JSON.parse(window.localStorage.getItem(storageKey) ?? "null");
}

describe("sidebar-order-store", () => {
	beforeEach(() => {
		window.localStorage.clear();
		useSidebarOrderStore.setState({ projectOrder: [], sessionOrderByProject: {} });
	});

	it("starts with no manual order", () => {
		expect(useSidebarOrderStore.getState()).toMatchObject({ projectOrder: [], sessionOrderByProject: {} });
	});

	it("persists a project order", () => {
		useSidebarOrderStore.getState().setProjectOrder(["p2", "p1"]);
		expect(useSidebarOrderStore.getState().projectOrder).toEqual(["p2", "p1"]);
		expect(stored()).toEqual({ version: 1, projects: ["p2", "p1"], sessionsByProject: {} });
	});

	it("persists a session order per project without touching its siblings", () => {
		useSidebarOrderStore.getState().setSessionOrder("p1", ["s2", "s1"]);
		useSidebarOrderStore.getState().setSessionOrder("p2", ["s4", "s3"]);
		expect(useSidebarOrderStore.getState().sessionOrderByProject).toEqual({
			p1: ["s2", "s1"],
			p2: ["s4", "s3"],
		});
		expect(stored().sessionsByProject).toEqual({ p1: ["s2", "s1"], p2: ["s4", "s3"] });
	});

	// A project drag always carries every project in the tree, so it doubles as
	// the prune for session orders belonging to projects that were removed.
	it("drops session orders for projects that are no longer in the tree", () => {
		useSidebarOrderStore.getState().setSessionOrder("p1", ["s2", "s1"]);
		useSidebarOrderStore.getState().setSessionOrder("gone", ["s9"]);
		useSidebarOrderStore.getState().setProjectOrder(["p1"]);
		expect(useSidebarOrderStore.getState().sessionOrderByProject).toEqual({ p1: ["s2", "s1"] });
		expect(stored().sessionsByProject).toEqual({ p1: ["s2", "s1"] });
	});

	it("reads the persisted order back on a fresh renderer boot", () => {
		useSidebarOrderStore.getState().setProjectOrder(["p2", "p1"]);
		useSidebarOrderStore.getState().setSessionOrder("p1", ["s2", "s1"]);

		// Simulate a reload: state is gone, localStorage is not.
		useSidebarOrderStore.setState({ projectOrder: [], sessionOrderByProject: {} });
		hydrateSidebarOrderFromStorage();

		expect(useSidebarOrderStore.getState()).toMatchObject({
			projectOrder: ["p2", "p1"],
			sessionOrderByProject: { p1: ["s2", "s1"] },
		});
	});

	it("falls back to the derived order for absent, corrupt, or foreign-versioned data", () => {
		expect(readStoredSidebarOrder()).toEqual({ projectOrder: [], sessionOrderByProject: {} });

		window.localStorage.setItem(storageKey, "{not json");
		expect(readStoredSidebarOrder()).toEqual({ projectOrder: [], sessionOrderByProject: {} });

		window.localStorage.setItem(storageKey, JSON.stringify({ version: 99, projects: ["p1"] }));
		expect(readStoredSidebarOrder()).toEqual({ projectOrder: [], sessionOrderByProject: {} });
	});

	it("ignores entries that are not lists of ids", () => {
		window.localStorage.setItem(
			storageKey,
			JSON.stringify({ version: 1, projects: ["p1", 7], sessionsByProject: { p1: ["s1"], p2: "nope" } }),
		);
		expect(readStoredSidebarOrder()).toEqual({ projectOrder: [], sessionOrderByProject: { p1: ["s1"] } });
	});
});
