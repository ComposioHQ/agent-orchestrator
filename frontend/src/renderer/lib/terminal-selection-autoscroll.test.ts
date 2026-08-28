import { describe, expect, it, vi } from "vitest";
import {
	edgeScrollLines,
	screenSnapshotExtension,
	SELECTION_SCROLL_INTERVAL_MS,
	TerminalSelectionAutoscroll,
	type TerminalScreenSnapshot,
} from "./terminal-selection-autoscroll";

describe("terminal selection edge calculations", () => {
	it("uses the same direction and 1-to-15 row speed curve on every platform", () => {
		expect(edgeScrollLines(100, 100, 400)).toBe(0);
		expect(edgeScrollLines(500, 100, 400)).toBe(0);
		expect(edgeScrollLines(99, 100, 400)).toBe(-1);
		expect(edgeScrollLines(75, 100, 400)).toBe(-8);
		expect(edgeScrollLines(50, 100, 400)).toBe(-15);
		expect(edgeScrollLines(501, 100, 400)).toBe(1);
		expect(edgeScrollLines(525, 100, 400)).toBe(8);
		expect(edgeScrollLines(550, 100, 400)).toBe(15);
	});

	it("stitches newly revealed rows in both directions", () => {
		expect(screenSnapshotExtension({ rows: ["two", "three"] }, { rows: ["one", "two", "three"] }, -1))
			.toEqual(["one"]);
		expect(screenSnapshotExtension({ rows: ["one", "two"] }, { rows: ["two", "three"] }, 1))
			.toEqual(["three"]);
	});

	it("excludes dim thinking and transient footer rows", () => {
		const previous = { rows: [
			{ text: "private reasoning", selectable: false },
			"two",
			"three",
			"muse-spark · high · ~/.ao/dev/data/worktrees/scratch-12",
		] };
		expect(screenSnapshotExtension(previous, { rows: ["one", "two", "three"] }, -1)).toEqual(["one"]);
	});
});

function createMachine(options?: {
	native?: string;
	range?: { anchor: { row: number; col: number }; focus: { row: number; col: number } };
	snapshot?: TerminalScreenSnapshot;
	scroll?: (direction: -1 | 1, lines: number) => void;
	render?: (state: { highlights: { row: number }[] } | null) => void;
	setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}) {
	return new TerminalSelectionAutoscroll({
		readNativeSelection: () => ({
			text: options?.native ?? "one\ntwo",
			range: options?.range ?? { anchor: { row: 0, col: 0 }, focus: { row: 1, col: 3 } },
		}),
		readSnapshot: () => options?.snapshot ?? { rows: ["one", "two"] },
		clearNativeSelection: vi.fn(),
		scroll: options?.scroll ?? vi.fn(),
		render: options?.render ?? vi.fn(),
		setInterval: options?.setInterval,
		clearInterval: options?.clearInterval,
	});
}

describe("TerminalSelectionAutoscroll", () => {
	it("keeps ordinary in-viewport selection native", () => {
		const render = vi.fn();
		const machine = createMachine({ render });
		machine.pointerDown(true);
		expect(machine.pointerMove({ row: 1, col: 2 }, 250, 100, 400)).toBe(false);
		machine.pointerUp();
		expect(machine.hasSelection()).toBe(false);
		expect(render).not.toHaveBeenCalledWith(expect.objectContaining({ highlights: expect.any(Array) }));
	});

	it.each([
		{ name: "upward", pointerY: 50, direction: -1 as const, initial: ["two", "three"], next: ["one", "two", "three"] },
		{ name: "downward", pointerY: 550, direction: 1 as const, initial: ["one", "two"], next: ["two", "three"] },
	])("scrolls $name and extends the copied range", ({ pointerY, direction, initial, next }) => {
		let tick: (() => void) | undefined;
		const snapshot: TerminalScreenSnapshot = { rows: [...initial] };
		const scroll = vi.fn();
		const machine = createMachine({
			native: initial.join("\n"),
			snapshot,
			scroll,
			setInterval: (callback, ms) => {
				expect(ms).toBe(SELECTION_SCROLL_INTERVAL_MS);
				tick = callback;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		expect(machine.pointerMove({ row: 0, col: 0 }, pointerY, 100, 400)).toBe(true);
		tick?.();
		expect(scroll).toHaveBeenCalledWith(direction, 15);
		snapshot.rows = next;
		machine.screenRendered();
		machine.pointerUp();
		expect(machine.getText()).toBe("one\ntwo\nthree");
	});

	it("retains the extended selection on mouseup for explicit copy", () => {
		const clearTimer = vi.fn();
		const machine = createMachine({
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: clearTimer,
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 0, col: 2 }, 50, 100, 400);
		machine.pointerUp();
		expect(machine.getText()).toBe("one\ntwo");
		expect(clearTimer).toHaveBeenCalled();
	});

	it("preserves exact native text and partial highlight boundaries", () => {
		const render = vi.fn();
		const machine = createMachine({
			native: "  const x = 1;  ",
			range: { anchor: { row: 0, col: 2 }, focus: { row: 0, col: 14 } },
			render,
			snapshot: { rows: ["  const x = 1;"] },
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 0, col: 14 }, 550, 100, 400);
		machine.pointerUp();
		expect(machine.getText()).toBe("  const x = 1;  ");
		expect(render).toHaveBeenCalledWith({ highlights: [{ row: 0, startCol: 2, endCol: 14 }] });
	});

	it("keeps partial native boundaries after the viewport moves", () => {
		const snapshot: TerminalScreenSnapshot = { rows: ["abcd"] };
		const render = vi.fn();
		const machine = createMachine({
			native: "bc",
			range: { anchor: { row: 0, col: 1 }, focus: { row: 0, col: 3 } },
			render,
			snapshot,
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 0, col: 1 }, 50, 100, 400);
		snapshot.rows = ["new", "abcd"];
		machine.screenRendered();
		expect(render).toHaveBeenLastCalledWith({ highlights: [
			{ row: 0, startCol: 0, endCol: 3 },
			{ row: 1, startCol: 1, endCol: 3 },
		] });
	});

	it("does not add a newline before a newly revealed wrapped row", () => {
		const snapshot: TerminalScreenSnapshot = { rows: ["hello"] };
		const machine = createMachine({
			native: "hello",
			snapshot,
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 0, col: 5 }, 550, 100, 400);
		snapshot.rows = ["hello", { text: " world", wrapped: true }];
		machine.screenRendered();
		machine.pointerUp();
		expect(machine.getText()).toBe("hello world");
	});

	it("preserves blank lines revealed across the viewport edge", () => {
		const snapshot: TerminalScreenSnapshot = { rows: ["one"] };
		const machine = createMachine({
			native: "one",
			snapshot,
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 0, col: 3 }, 550, 100, 400);
		snapshot.rows = ["one", "", "two"];
		machine.screenRendered();
		machine.pointerUp();
		expect(machine.getText()).toBe("one\n\ntwo");
	});

	it("maps terminal cell columns across wide Unicode characters", () => {
		const snapshot: TerminalScreenSnapshot = {
			rows: [{ text: "界b", cellOffsets: [0, 1, 1, 2] }],
		};
		const machine = createMachine({
			native: "界b",
			range: { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 3 } },
			snapshot,
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 0, col: 3 }, 550, 100, 400);
		machine.pointerMove({ row: 0, col: 2 }, 300, 100, 400);
		machine.pointerUp();
		expect(machine.getText()).toBe("界");
	});

	it("shrinks the extended end when the pointer returns inside", () => {
		const snapshot: TerminalScreenSnapshot = { rows: ["one"] };
		const machine = createMachine({
			native: "one",
			snapshot,
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 0, col: 3 }, 550, 100, 400);
		snapshot.rows = ["one", "two", "three"];
		machine.screenRendered();
		machine.pointerMove({ row: 1, col: 2 }, 300, 100, 400);
		machine.pointerUp();
		expect(machine.getText()).toBe("one\ntw");
	});

	it("restores intervening rows when a shrunken selection extends again", () => {
		const snapshot: TerminalScreenSnapshot = { rows: ["one", "two", "three"] };
		const machine = createMachine({
			native: "one\ntwo\nthree",
			range: { anchor: { row: 0, col: 0 }, focus: { row: 2, col: 5 } },
			snapshot,
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 2, col: 5 }, 550, 100, 400);
		snapshot.rows = ["two", "three", "four"];
		machine.screenRendered();
		machine.pointerMove({ row: 1, col: 2 }, 300, 100, 400);
		machine.pointerMove({ row: 2, col: 4 }, 550, 100, 400);
		snapshot.rows = ["three", "four", "five"];
		machine.screenRendered();
		machine.pointerUp();
		expect(machine.getText()).toBe("one\ntwo\nthree\nfour\nfive");
	});

	it("drops the old side of the range when the edge direction reverses", () => {
		const snapshot: TerminalScreenSnapshot = { rows: ["one", "two", "three"] };
		const machine = createMachine({
			native: "one\ntwo\nthree",
			range: { anchor: { row: 0, col: 0 }, focus: { row: 2, col: 5 } },
			snapshot,
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 2, col: 5 }, 550, 100, 400);
		snapshot.rows = ["two", "three", "four"];
		machine.screenRendered();
		expect(machine.getText()).toBe("one\ntwo\nthree\nfour");
		machine.pointerMove({ row: 0, col: 0 }, 50, 100, 400);
		snapshot.rows = ["zero", "one", "two"];
		machine.screenRendered();
		machine.pointerUp();
		expect(machine.getText()).toBe("zero");
	});

	it("shrinks the old side while reversing toward an offscreen anchor", () => {
		const snapshot: TerminalScreenSnapshot = { rows: ["one", "two", "three"] };
		const machine = createMachine({
			native: "one\ntwo\nthree",
			range: { anchor: { row: 0, col: 0 }, focus: { row: 2, col: 5 } },
			snapshot,
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 2, col: 5 }, 550, 100, 400);
		snapshot.rows = ["two", "three", "four"];
		machine.screenRendered();
		snapshot.rows = ["three", "four", "five"];
		machine.screenRendered();
		expect(machine.getText()).toBe("one\ntwo\nthree\nfour\nfive");
		machine.pointerMove({ row: 0, col: 2 }, 50, 100, 400);
		snapshot.rows = ["two", "three", "four"];
		machine.screenRendered();
		machine.pointerUp();
		expect(machine.getText()).toBe("one");
	});

	it("clears selection and its timer on blur", () => {
		const clearTimer = vi.fn();
		const render = vi.fn();
		const machine = createMachine({
			render,
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: clearTimer,
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 0, col: 0 }, 50, 100, 400);
		machine.blur();
		expect(machine.hasSelection()).toBe(false);
		expect(clearTimer).toHaveBeenCalled();
		expect(render).toHaveBeenLastCalledWith(null);
	});

	it("does not activate for ineligible panes or transient-only selections", () => {
		const scroll = vi.fn();
		const ineligible = createMachine({ scroll });
		ineligible.pointerDown(false);
		expect(ineligible.pointerMove({ row: 0, col: 0 }, 50, 100, 400)).toBe(false);

		const transient = createMachine({ native: "Thinking…\nscratch footer", scroll });
		transient.pointerDown(true);
		expect(transient.pointerMove({ row: 0, col: 0 }, 50, 100, 400)).toBe(false);
		expect(scroll).not.toHaveBeenCalled();
	});

	it("changes direction and speed while the pointer stays outside", () => {
		let tick: (() => void) | undefined;
		const scroll = vi.fn();
		const machine = createMachine({
			scroll,
			setInterval: (callback) => {
				tick = callback;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: vi.fn(),
		});
		machine.pointerDown(true);
		machine.pointerMove({ row: 0, col: 0 }, 99, 100, 400);
		tick?.();
		machine.pointerMove({ row: 1, col: 0 }, 525, 100, 400);
		tick?.();
		expect(scroll.mock.calls).toEqual([[-1, 1], [1, 8]]);
	});
});
