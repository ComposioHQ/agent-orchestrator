// @pierre/diffs owns diff parsing (getSingularPatch) and rendering; this file
// only adapts its parsed FileDiffMetadata into the flat, line-numbered shape
// the annotation and selection->instruction features need (which side/line
// number a gutter click or a line-range selection landed on, and what text
// lives there). @pierre/diffs exposes an equivalent internal walker
// (iterateOverDiff) but does not export it from the package's public entry
// points, so this is a small reimplementation limited to what those two
// features require — no diff parsing, no text-level LCS highlighting (Shiki
// renders the highlighted diff itself now).
import type { AnnotationSide, ChangeContent, ContextContent, FileDiffMetadata, Hunk, SelectedLineRange } from "@pierre/diffs";

export type DiffLineKind = "context" | "add" | "del";

export type ResolvedDiffLine = {
	kind: DiffLineKind;
	oldNo: number | null;
	newNo: number | null;
	text: string;
};

// FileDiffMetadata.deletionLines / additionLines retain each line's original
// line-ending characters (so the library can reconstruct the file exactly);
// strip them here since every consumer of ResolvedDiffLine wants plain text,
// matching what the old hand-written parser (which split on "\n") produced.
function lineTextAt(lines: string[], index: number): string {
	return (lines[index] ?? "").replace(/\r?\n$/, "");
}

function flattenHunk(hunk: Hunk, fileDiff: FileDiffMetadata): ResolvedDiffLine[] {
	const rows: ResolvedDiffLine[] = [];
	let oldNo = hunk.deletionStart;
	let newNo = hunk.additionStart;
	for (const block of hunk.hunkContent) {
		if (block.type === "context") {
			const context = block as ContextContent;
			for (let i = 0; i < context.lines; i += 1) {
				const text = lineTextAt(fileDiff.deletionLines, context.deletionLineIndex + i);
				rows.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text });
			}
			continue;
		}
		const change = block as ChangeContent;
		for (let i = 0; i < change.deletions; i += 1) {
			rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: lineTextAt(fileDiff.deletionLines, change.deletionLineIndex + i) });
		}
		for (let i = 0; i < change.additions; i += 1) {
			rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: lineTextAt(fileDiff.additionLines, change.additionLineIndex + i) });
		}
	}
	return rows;
}

// flattenDiffLines walks every hunk in document order (context and change
// blocks interleaved exactly as they render), producing the same row shape
// the old hand-written parser did minus hunk-header rows and intra-line
// segments. Call once per parsed diff and reuse the result — it's the shared
// lookup table behind both resolveDiffLineAt and sliceSelectedDiffLines.
export function flattenDiffLines(fileDiff: FileDiffMetadata): ResolvedDiffLine[] {
	return fileDiff.hunks.flatMap((hunk) => flattenHunk(hunk, fileDiff));
}

function matchesSide(line: ResolvedDiffLine, side: AnnotationSide | undefined, lineNumber: number): boolean {
	if (side === "deletions") return line.oldNo === lineNumber;
	if (side === "additions") return line.newNo === lineNumber;
	// No side given (e.g. a click that @pierre/diffs didn't scope to a
	// column): a context line satisfies either side, so match on whichever
	// number is present.
	return line.oldNo === lineNumber || line.newNo === lineNumber;
}

// resolveDiffLineAt finds the single row @pierre/diffs identified via a
// gutter-utility click (side + line number), used to build the annotation
// target (paired old/new numbers, kind, and source text) for the feedback
// composer.
export function resolveDiffLineAt(rows: ResolvedDiffLine[], side: AnnotationSide | undefined, lineNumber: number): ResolvedDiffLine | null {
	return rows.find((row) => matchesSide(row, side, lineNumber)) ?? null;
}

// sliceSelectedDiffLines maps a @pierre/diffs SelectedLineRange (line-number
// endpoints, not row indexes) onto the contiguous run of rows between them,
// in the same order they render — including any hunk boundary crossed in
// between, matching the old DOM-row-index slice's behavior.
export function sliceSelectedDiffLines(rows: ResolvedDiffLine[], range: SelectedLineRange): ResolvedDiffLine[] {
	const startIndex = rows.findIndex((row) => matchesSide(row, range.side, range.start));
	const endIndex = rows.findIndex((row) => matchesSide(row, range.endSide ?? range.side, range.end));
	if (startIndex === -1 || endIndex === -1) return [];
	const [min, max] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
	return rows.slice(min, max + 1);
}
