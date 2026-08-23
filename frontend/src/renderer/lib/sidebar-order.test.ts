import { describe, expect, it } from "vitest";
import { applyManualOrder, moveByOffset, reorderById } from "./sidebar-order";

type Row = { id: string };

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (items: Row[]) => items.map((item) => item.id);
const byId = (item: Row) => item.id;

describe("applyManualOrder", () => {
	it("keeps the derived order when nothing has been placed by hand", () => {
		expect(ids(applyManualOrder(rows("a", "b", "c"), byId, undefined, "end"))).toEqual(["a", "b", "c"]);
		expect(ids(applyManualOrder(rows("a", "b", "c"), byId, [], "end"))).toEqual(["a", "b", "c"]);
	});

	it("applies the manual order", () => {
		expect(ids(applyManualOrder(rows("a", "b", "c"), byId, ["c", "a", "b"], "end"))).toEqual(["c", "a", "b"]);
	});

	it("appends never-placed projects so a newly added project lands last", () => {
		expect(ids(applyManualOrder(rows("a", "b", "new"), byId, ["b", "a"], "end"))).toEqual(["b", "a", "new"]);
	});

	it("prepends never-placed sessions so a freshly spawned session stays on top", () => {
		expect(ids(applyManualOrder(rows("new", "a", "b"), byId, ["b", "a"], "start"))).toEqual(["new", "b", "a"]);
	});

	it("keeps never-placed items in their derived relative order", () => {
		expect(ids(applyManualOrder(rows("n1", "n2", "a"), byId, ["a"], "start"))).toEqual(["n1", "n2", "a"]);
	});

	it("ignores ids that are no longer present and duplicate entries", () => {
		expect(ids(applyManualOrder(rows("a", "b"), byId, ["gone", "b", "b", "a"], "end"))).toEqual(["b", "a"]);
	});

	it("does not mutate the input list", () => {
		const items = rows("a", "b");
		applyManualOrder(items, byId, ["b", "a"], "end");
		expect(ids(items)).toEqual(["a", "b"]);
	});
});

describe("reorderById", () => {
	it("moves an item down into the target slot", () => {
		expect(reorderById(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
	});

	it("moves an item up into the target slot", () => {
		expect(reorderById(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
	});

	it("rejects a drop onto itself", () => {
		expect(reorderById(["a", "b"], "a", "a")).toBeNull();
	});

	// The cross-project guard: a session dropped over another project's list has
	// an `over` id this project's order knows nothing about, so nothing is written.
	it("rejects a drop whose target belongs to another list", () => {
		expect(reorderById(["a-1", "a-2"], "a-1", "b-1")).toBeNull();
	});

	it("rejects a drop whose dragged item belongs to another list", () => {
		expect(reorderById(["a-1", "a-2"], "b-1", "a-2")).toBeNull();
	});
});

describe("moveByOffset", () => {
	it("nudges an item up and down one slot", () => {
		expect(moveByOffset(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
		expect(moveByOffset(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
	});

	it("stops at the ends of the list instead of wrapping into a neighbour", () => {
		expect(moveByOffset(["a", "b"], "a", -1)).toBeNull();
		expect(moveByOffset(["a", "b"], "b", 1)).toBeNull();
	});

	it("rejects an id from another list", () => {
		expect(moveByOffset(["a-1", "a-2"], "b-1", 1)).toBeNull();
	});
});
