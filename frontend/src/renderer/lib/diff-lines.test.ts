import { getSingularPatch } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { flattenDiffLines, resolveDiffLineAt, sliceSelectedDiffLines } from "./diff-lines";

const multiHunkDiff =
	"diff --git a/src/App.tsx b/src/App.tsx\n" +
	"index 111..222 100644\n" +
	"--- a/src/App.tsx\n" +
	"+++ b/src/App.tsx\n" +
	"@@ -1,3 +1,3 @@\n" +
	" line one\n" +
	"-line two\n" +
	"+line two changed\n" +
	" line three\n" +
	"@@ -10,3 +10,2 @@\n" +
	" line ten\n" +
	"-line eleven\n" +
	" line twelve\n";

const addedFileDiff =
	"diff --git a/new.txt b/new.txt\n" +
	"new file mode 100644\n" +
	"--- /dev/null\n" +
	"+++ b/new.txt\n" +
	"@@ -0,0 +1,2 @@\n" +
	"+first\n" +
	"+second\n";

describe("flattenDiffLines", () => {
	it("walks hunks in document order with paired old/new numbers", () => {
		const rows = flattenDiffLines(getSingularPatch(multiHunkDiff));
		expect(rows).toEqual([
			{ kind: "context", oldNo: 1, newNo: 1, text: "line one" },
			{ kind: "del", oldNo: 2, newNo: null, text: "line two" },
			{ kind: "add", oldNo: null, newNo: 2, text: "line two changed" },
			{ kind: "context", oldNo: 3, newNo: 3, text: "line three" },
			{ kind: "context", oldNo: 10, newNo: 10, text: "line ten" },
			{ kind: "del", oldNo: 11, newNo: null, text: "line eleven" },
			{ kind: "context", oldNo: 12, newNo: 11, text: "line twelve" },
		]);
	});

	it("marks every line as an addition for a brand-new file", () => {
		const rows = flattenDiffLines(getSingularPatch(addedFileDiff));
		expect(rows).toEqual([
			{ kind: "add", oldNo: null, newNo: 1, text: "first" },
			{ kind: "add", oldNo: null, newNo: 2, text: "second" },
		]);
	});
});

describe("resolveDiffLineAt", () => {
	const rows = flattenDiffLines(getSingularPatch(multiHunkDiff));

	it("finds a deletion by its old-side number", () => {
		expect(resolveDiffLineAt(rows, "deletions", 2)).toEqual({ kind: "del", oldNo: 2, newNo: null, text: "line two" });
	});

	it("finds an addition by its new-side number", () => {
		expect(resolveDiffLineAt(rows, "additions", 2)).toEqual({
			kind: "add",
			oldNo: null,
			newNo: 2,
			text: "line two changed",
		});
	});

	it("finds a context line from either side's number", () => {
		expect(resolveDiffLineAt(rows, "deletions", 12)).toEqual({
			kind: "context",
			oldNo: 12,
			newNo: 11,
			text: "line twelve",
		});
		expect(resolveDiffLineAt(rows, "additions", 11)).toEqual({
			kind: "context",
			oldNo: 12,
			newNo: 11,
			text: "line twelve",
		});
	});

	it("returns null for a line number that doesn't exist on the requested side", () => {
		expect(resolveDiffLineAt(rows, "additions", 11 + 1000)).toBeNull();
	});
});

describe("sliceSelectedDiffLines", () => {
	const rows = flattenDiffLines(getSingularPatch(multiHunkDiff));

	it("includes every rendered row between two hunks, dropping the hunk boundary itself", () => {
		// "line one" (new line 1) through "line twelve" (new line 11) — spans
		// both hunks and the gap between them.
		const lines = sliceSelectedDiffLines(rows, { start: 1, side: "additions", end: 11, endSide: "additions" });
		expect(lines.map((line) => line.text)).toEqual([
			"line one",
			"line two",
			"line two changed",
			"line three",
			"line ten",
			"line eleven",
			"line twelve",
		]);
	});

	it("resolves a reversed range (end before start) the same as a forward one", () => {
		const forward = sliceSelectedDiffLines(rows, { start: 1, side: "additions", end: 3, endSide: "additions" });
		const reversed = sliceSelectedDiffLines(rows, { start: 3, side: "additions", end: 1, endSide: "additions" });
		expect(reversed).toEqual(forward);
	});

	it("confines a single-side selection to that side's lines only", () => {
		const lines = sliceSelectedDiffLines(rows, { start: 2, side: "deletions", end: 2, endSide: "deletions" });
		expect(lines).toEqual([{ kind: "del", oldNo: 2, newNo: null, text: "line two" }]);
	});

	it("returns an empty array when an endpoint doesn't resolve to any row", () => {
		expect(sliceSelectedDiffLines(rows, { start: 999, side: "additions", end: 1000, endSide: "additions" })).toEqual([]);
	});
});
