export type TerminalSelectionPoint = { row: number; col: number };
export type TerminalSelectionRange = { anchor: TerminalSelectionPoint; focus: TerminalSelectionPoint };
export type NativeTerminalSelection = { text: string; range: TerminalSelectionRange };
export type TerminalSelectionHighlight = { row: number; startCol: number; endCol: number };
export type TerminalScreenRow = {
	text: string;
	cellOffsets?: number[];
	endCol?: number;
	selectable?: boolean;
	wrapped?: boolean;
};
export type TerminalScreenSnapshot = { rows: Array<string | TerminalScreenRow> };
export type TerminalLiveSelectionRender = { highlights: TerminalSelectionHighlight[] };

const EDGE_MAX_DISTANCE_PX = 50;
const EDGE_MAX_LINES = 15;
export const SELECTION_SCROLL_INTERVAL_MS = 50;

export function edgeScrollLines(pointerY: number, top: number, height: number): number {
	let offset = pointerY - top;
	if (offset >= 0 && offset <= height) return 0;
	if (offset > height) offset -= height;
	offset = Math.min(Math.max(offset, -EDGE_MAX_DISTANCE_PX), EDGE_MAX_DISTANCE_PX);
	const normalized = offset / EDGE_MAX_DISTANCE_PX;
	return Math.sign(normalized) + Math.round(normalized * (EDGE_MAX_LINES - 1));
}

function comparePoints(left: TerminalSelectionPoint, right: TerminalSelectionPoint): number {
	return left.row === right.row ? left.col - right.col : left.row - right.row;
}

function screenRow(row: string | TerminalScreenRow): TerminalScreenRow {
	return typeof row === "string" ? { text: row } : row;
}

export function isTerminalSelectionChrome(text: string, allTextIsDim: boolean): boolean {
	const trimmed = text.trim();
	if (/Paste again to expand for editing/iu.test(trimmed) ||
		/^scratch(?:-\d+)? footer$/iu.test(trimmed) ||
		/^[^·\n]+ · [^·\n]+ · (?:~|\/)\S+/u.test(trimmed)) return true;
	if (!allTextIsDim) return false;
	return /^[─━═]+$/u.test(trimmed) ||
		/^(?:Pouncing|Thinking|Working|Generating|Loading|Update available|Jump to bottom)(?:…|\.\.\.)?$/iu.test(trimmed);
}

type SelectableScreenRow = TerminalSelectionHighlight & { cellOffsets?: number[]; text: string; wrapped: boolean };

function selectableRow(value: string | TerminalScreenRow, row: number): SelectableScreenRow | null {
	const current = screenRow(value);
	if (current.selectable === false) return null;
	const trailing = current.text.match(/\s*$/u)?.[0].length ?? 0;
	const textEnd = Math.max(0, current.text.length - trailing);
	const endCol = current.endCol ?? current.cellOffsets?.findIndex((offset) => offset >= textEnd) ?? textEnd;
	return {
		row,
		startCol: 0,
		endCol: Math.max(0, endCol),
		cellOffsets: current.cellOffsets,
		text: current.text.slice(0, textEnd),
		wrapped: current.wrapped === true,
	};
}

function selectableScreenRows(snapshot: TerminalScreenSnapshot): SelectableScreenRow[] {
	const rows = snapshot.rows.flatMap((value, row) => {
		const selected = selectableRow(value, row);
		return selected ? [selected] : [];
	});
	while (rows[0]?.text === "") rows.shift();
	while (rows.at(-1)?.text === "") rows.pop();
	return rows;
}

function cloneSnapshot(snapshot: TerminalScreenSnapshot): TerminalScreenSnapshot {
	return { rows: snapshot.rows.map((value) => typeof value === "string" ? value : { ...value }) };
}

function rowKey(row: Pick<SelectableScreenRow, "text" | "wrapped">): string {
	return `${row.wrapped ? "1" : "0"}:${row.text}`;
}

function longestPrefixOverlap(left: SelectableScreenRow[], right: SelectableScreenRow[]): number {
	const maximum = Math.min(left.length, right.length);
	for (let length = maximum; length > 0; length -= 1) {
		if (left.slice(left.length - length).every((value, index) => rowKey(value) === rowKey(right[index]))) return length;
	}
	return 0;
}

function appendUnique(left: SelectableScreenRow[], right: SelectableScreenRow[]): SelectableScreenRow[] {
	const overlap = longestPrefixOverlap(left, right);
	return [...left, ...right.slice(overlap)];
}

function lastMatchingRowIndex(rows: SelectableScreenRow[], target: SelectableScreenRow): number {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		if (rowKey(rows[index]) === rowKey(target)) return index;
	}
	return -1;
}

function snapshotExtensionRows(
	previous: TerminalScreenSnapshot,
	next: TerminalScreenSnapshot,
	direction: -1 | 1,
	allowNoOverlap = false,
): SelectableScreenRow[] {
	const before = selectableScreenRows(previous);
	const after = selectableScreenRows(next);
	if (direction < 0) {
		const overlap = longestPrefixOverlap(after, before);
		if (overlap === 0 && before.length > 0 && after.length > 0) return allowNoOverlap ? after : [];
		const extension = after.slice(0, after.length - overlap);
		const previousEdge = screenRow(previous.rows[0] ?? "").text;
		const nextEdge = screenRow(next.rows[0] ?? "").text;
		if (extension.length === 0 && previousEdge !== "" && nextEdge === "") {
			return [{ row: 0, startCol: 0, endCol: 0, text: "", wrapped: false }];
		}
		return extension;
	}
	const overlap = longestPrefixOverlap(before, after);
	if (overlap === 0 && before.length > 0 && after.length > 0) return allowNoOverlap ? after : [];
	const extension = after.slice(overlap);
	const previousEdge = screenRow(previous.rows.at(-1) ?? "").text;
	const nextEdge = screenRow(next.rows.at(-1) ?? "").text;
	if (extension.length === 0 && previousEdge !== "" && nextEdge === "") {
		return [{ row: Math.max(0, next.rows.length - 1), startCol: 0, endCol: 0, text: "", wrapped: false }];
	}
	return extension;
}

export function screenSnapshotExtension(
	previous: TerminalScreenSnapshot,
	next: TerminalScreenSnapshot,
	direction: -1 | 1,
): string[] {
	return snapshotExtensionRows(previous, next, direction).map((row) => row.text);
}

function sameSnapshot(left: TerminalScreenSnapshot, right: TerminalScreenSnapshot): boolean {
	if (left.rows.length !== right.rows.length) return false;
	return left.rows.every((value, index) => {
		const leftRow = screenRow(value);
		const rightRow = screenRow(right.rows[index]);
		return leftRow.text === rightRow.text &&
			leftRow.endCol === rightRow.endCol &&
			leftRow.selectable === rightRow.selectable &&
			leftRow.wrapped === rightRow.wrapped;
	});
}

function textOffsetForCell(row: SelectableScreenRow, col: number): number {
	if (!row.cellOffsets) return Math.min(row.text.length, Math.max(0, col));
	const bounded = Math.min(row.cellOffsets.length - 1, Math.max(0, col));
	return Math.min(row.text.length, row.cellOffsets[bounded] ?? row.text.length);
}

function joinedRows(rows: SelectableScreenRow[]): string {
	let text = "";
	for (const [index, row] of rows.entries()) {
		if (index > 0 && !row.wrapped) text += "\n";
		text += row.text.slice(textOffsetForCell(row, row.startCol), textOffsetForCell(row, row.endCol));
	}
	return text;
}

type TimerHandle = ReturnType<typeof setInterval>;

export type TerminalSelectionAutoscrollOptions = {
	readNativeSelection: () => NativeTerminalSelection | null;
	readSnapshot: () => TerminalScreenSnapshot;
	clearNativeSelection: () => void;
	scroll: (direction: -1 | 1, lines: number) => boolean | void;
	render: (state: TerminalLiveSelectionRender | null) => void;
	setInterval?: (callback: () => void, ms: number) => TimerHandle;
	clearInterval?: (handle: TimerHandle) => void;
};

export class TerminalSelectionAutoscroll {
	private phase: "idle" | "native" | "active" | "complete" = "idle";
	private edgeLines = 0;
	private direction: -1 | 1 = 1;
	private timer: TimerHandle | null = null;
	private initialText = "";
	private initialRows: SelectableScreenRow[] = [];
	private initialHighlights: TerminalSelectionHighlight[] = [];
	private initialStartsWrapped = false;
	private baseInitialText = "";
	private baseInitialRows: SelectableScreenRow[] = [];
	private baseInitialHighlights: TerminalSelectionHighlight[] = [];
	private baseInitialStartsWrapped = false;
	private baseScreenRows: SelectableScreenRow[] = [];
	private anchorPoint: TerminalSelectionPoint | null = null;
	private prefix: SelectableScreenRow[] = [];
	private suffix: SelectableScreenRow[] = [];
	private previousSnapshot: TerminalScreenSnapshot | null = null;
	private showInitialHighlights = false;
	private insideFocus: TerminalSelectionPoint | null = null;
	private trimmingToAnchor = false;
	private scrollRequested = false;

	constructor(private readonly options: TerminalSelectionAutoscrollOptions) {}

	pointerDown(eligible: boolean): void {
		this.reset();
		if (eligible) this.phase = "native";
	}

	pointerMove(point: TerminalSelectionPoint, pointerY: number, top: number, height: number): boolean {
		if (this.phase === "idle" || this.phase === "complete") return false;
		this.edgeLines = edgeScrollLines(pointerY, top, height);
		if (this.phase === "native") {
			if (this.edgeLines === 0) return false;
			this.activate();
			return this.isActive();
		}
		this.options.clearNativeSelection();
		if (this.edgeLines === 0) {
			this.stopTimer();
			this.moveFocusInside(point);
		} else {
			const direction = Math.sign(this.edgeLines) as -1 | 1;
			if (direction !== this.direction) {
				this.trimmingToAnchor = true;
				this.insideFocus = null;
			}
			this.direction = direction;
			if (this.insideFocus && !this.trimmingToAnchor) {
				this.fillVisibleGap(this.insideFocus, direction);
				this.insideFocus = null;
			}
			this.startTimer();
		}
		return true;
	}

	pointerUp(): void {
		if (this.phase === "native") {
			this.phase = "idle";
			return;
		}
		if (this.phase !== "active") return;
		this.stopTimer();
		this.phase = "complete";
	}

	screenRendered(): void {
		if (this.phase === "complete") {
			this.previousSnapshot = cloneSnapshot(this.options.readSnapshot());
			this.render();
			return;
		}
		if (this.phase !== "active") return;
		const snapshot = this.options.readSnapshot();
		if (this.previousSnapshot && !sameSnapshot(this.previousSnapshot, snapshot)) {
			this.showInitialHighlights = false;
			if (this.edgeLines !== 0) {
				let extension = snapshotExtensionRows(this.previousSnapshot, snapshot, this.direction, this.scrollRequested);
				if (this.trimmingToAnchor && this.anchorPoint) {
					const anchor = this.baseScreenRows.find((row) => row.row === this.anchorPoint?.row);
					const visibleRows = selectableScreenRows(snapshot);
					const anchorIndex = anchor ? visibleRows.findIndex((row) => rowKey(row) === rowKey(anchor)) : -1;
					if (anchorIndex < 0) {
						this.shrinkTowardAnchor(visibleRows, this.direction);
						extension = [];
					} else {
						this.restoreSelectionAtAnchor(this.direction);
						this.prefix = [];
						this.suffix = [];
						extension = this.direction < 0
							? visibleRows.slice(0, anchorIndex)
							: visibleRows.slice(anchorIndex + 1);
						this.trimmingToAnchor = false;
					}
				}
				if (this.direction < 0) this.prefix = appendUnique(extension, this.prefix);
				else this.suffix = appendUnique(this.suffix, extension);
			}
		}
		this.scrollRequested = false;
		this.previousSnapshot = cloneSnapshot(snapshot);
		this.render();
	}

	getText(): string {
		if (this.phase !== "active" && this.phase !== "complete") return "";
		const before = joinedRows(this.prefix);
		const after = joinedRows(this.suffix);
		let text = this.initialText;
		if (this.prefix.length > 0) text = `${before}${text && !this.initialStartsWrapped ? "\n" : ""}${text}`;
		if (this.suffix.length > 0) text = `${text}${text && !this.suffix[0]?.wrapped ? "\n" : ""}${after}`;
		return text;
	}

	hasSelection(): boolean { return this.getText().length > 0; }
	isActive(): boolean { return this.phase === "active"; }
	blur(): void { this.reset(); }
	dispose(): void { this.reset(); }

	private activate(): void {
		const nativeSelection = this.options.readNativeSelection();
		if (!nativeSelection || nativeSelection.text.length === 0) return;
		const initialText = nativeSelection.text;
		const snapshot = this.options.readSnapshot();
		const start = comparePoints(nativeSelection.range.anchor, nativeSelection.range.focus) <= 0
			? nativeSelection.range.anchor
			: nativeSelection.range.focus;
		const end = start === nativeSelection.range.anchor ? nativeSelection.range.focus : nativeSelection.range.anchor;
		this.baseScreenRows = selectableScreenRows(snapshot);
		this.initialRows = this.baseScreenRows
			.filter((row) => row.row >= start.row && row.row <= end.row)
			.flatMap((row) => {
				const startCol = row.row === start.row ? Math.max(row.startCol, start.col) : row.startCol;
				const endCol = row.row === end.row ? Math.min(row.endCol, end.col) : row.endCol;
				return endCol > startCol ? [{ ...row, startCol, endCol }] : [];
			});
		this.initialHighlights = this.initialRows.map(({ row, startCol, endCol }) => ({ row, startCol, endCol }));
		this.initialStartsWrapped = screenRow(snapshot.rows[start.row] ?? "").wrapped === true;
		this.initialText = initialText;
		this.baseInitialText = this.initialText;
		this.baseInitialRows = this.initialRows.map((row) => ({ ...row }));
		this.baseInitialHighlights = this.initialHighlights.map((highlight) => ({ ...highlight }));
		this.baseInitialStartsWrapped = this.initialStartsWrapped;
		this.direction = Math.sign(this.edgeLines) as -1 | 1;
		this.anchorPoint = this.direction > 0 ? { ...start } : { ...end };
		this.previousSnapshot = cloneSnapshot(snapshot);
		this.showInitialHighlights = true;
		this.phase = "active";
		this.options.clearNativeSelection();
		this.render();
		this.startTimer();
	}

	private moveFocusInside(point: TerminalSelectionPoint): void {
		const current = selectableScreenRows(this.options.readSnapshot());
		const targetIndex = current.findIndex((row) => row.row === point.row);
		const target = current[targetIndex];
		if (!target) return;
		this.insideFocus = point;
		if (this.trimmingToAnchor && this.anchorPoint) {
			const baseAnchorIndex = this.baseInitialRows.findIndex((row) => row.row === this.anchorPoint?.row);
			const knownRows = [...this.prefix, ...this.baseInitialRows, ...this.suffix];
			const anchorIndex = baseAnchorIndex < 0 ? -1 : this.prefix.length + baseAnchorIndex;
			let knownTargetIndex = this.prefix.findIndex((row) => rowKey(row) === rowKey(target));
			if (knownTargetIndex < 0) {
				const baseTargetIndex = this.baseInitialRows.findIndex((row) => rowKey(row) === rowKey(target));
				if (baseTargetIndex >= 0) knownTargetIndex = this.prefix.length + baseTargetIndex;
			}
			if (knownTargetIndex < 0) {
				const suffixTargetIndex = lastMatchingRowIndex(this.suffix, target);
				if (suffixTargetIndex >= 0) {
					knownTargetIndex = this.prefix.length + this.baseInitialRows.length + suffixTargetIndex;
				}
			}
			if (anchorIndex >= 0 && knownTargetIndex >= 0) {
				this.selectKnownRange(knownRows, anchorIndex, knownTargetIndex, point);
				this.direction = knownTargetIndex < anchorIndex ? -1 : 1;
				this.trimmingToAnchor = false;
				this.previousSnapshot = cloneSnapshot(this.options.readSnapshot());
				this.render();
				return;
			}
		}
		if (this.direction > 0) {
			const index = lastMatchingRowIndex(this.suffix, target);
			if (index >= 0) {
				this.suffix = this.suffix.slice(0, index + 1);
				const endCol = Math.min(target.endCol, Math.max(target.startCol, point.col));
				if (endCol === target.startCol) this.suffix.pop();
				else this.suffix[this.suffix.length - 1] = { ...this.suffix.at(-1)!, endCol };
			} else {
				const initialIndex = lastMatchingRowIndex(this.initialRows, target);
				if (initialIndex >= 0) {
					this.suffix = [];
					this.initialRows = this.initialRows.slice(0, initialIndex + 1);
					const endCol = Math.min(target.endCol, Math.max(target.startCol, point.col));
					if (endCol === target.startCol) this.initialRows.pop();
					else this.initialRows[this.initialRows.length - 1] = { ...this.initialRows.at(-1)!, endCol };
					this.refreshInitialText();
				}
			}
		} else {
			const index = this.prefix.findIndex((row) => rowKey(row) === rowKey(target));
			if (index >= 0) {
				this.prefix = this.prefix.slice(index);
				const startCol = Math.min(target.endCol, Math.max(target.startCol, point.col));
				if (startCol === target.endCol) this.prefix.shift();
				else this.prefix[0] = { ...this.prefix[0], startCol };
			} else {
				const initialIndex = this.initialRows.findIndex((row) => rowKey(row) === rowKey(target));
				if (initialIndex >= 0) {
					this.prefix = [];
					this.initialRows = this.initialRows.slice(initialIndex);
					const startCol = Math.min(target.endCol, Math.max(target.startCol, point.col));
					if (startCol === target.endCol) this.initialRows.shift();
					else this.initialRows[0] = { ...this.initialRows[0], startCol };
					this.refreshInitialText();
				}
			}
		}
		this.trimmingToAnchor = false;
		this.previousSnapshot = cloneSnapshot(this.options.readSnapshot());
		this.render();
	}

	private selectKnownRange(
		rows: SelectableScreenRow[],
		anchorIndex: number,
		focusIndex: number,
		focus: TerminalSelectionPoint,
	): void {
		const anchor = this.anchorPoint;
		if (!anchor) return;
		const firstIndex = Math.min(anchorIndex, focusIndex);
		const lastIndex = Math.max(anchorIndex, focusIndex);
		const selected = rows.slice(firstIndex, lastIndex + 1).map((row) => ({ ...row }));
		if (selected.length === 0) return;
		if (anchorIndex === focusIndex) {
			selected[0].startCol = Math.min(anchor.col, focus.col);
			selected[0].endCol = Math.max(anchor.col, focus.col);
		} else if (anchorIndex < focusIndex) {
			selected[0].startCol = Math.min(selected[0].endCol, Math.max(selected[0].startCol, anchor.col));
			selected[selected.length - 1].endCol = Math.min(
				selected[selected.length - 1].endCol,
				Math.max(selected[selected.length - 1].startCol, focus.col),
			);
		} else {
			selected[0].startCol = Math.min(selected[0].endCol, Math.max(selected[0].startCol, focus.col));
			selected[selected.length - 1].endCol = Math.min(
				selected[selected.length - 1].endCol,
				Math.max(selected[selected.length - 1].startCol, anchor.col),
			);
		}
		this.prefix = [];
		this.suffix = [];
		this.initialRows = selected.filter((row) => row.endCol > row.startCol);
		this.showInitialHighlights = false;
		this.refreshInitialText();
	}

	private fillVisibleGap(point: TerminalSelectionPoint, direction: -1 | 1): void {
		const current = selectableScreenRows(this.options.readSnapshot());
		const targetIndex = current.findIndex((row) => row.row === point.row);
		if (targetIndex < 0) return;
		const target = current[targetIndex];
		if (direction > 0) {
			const suffixIndex = lastMatchingRowIndex(this.suffix, target);
			if (suffixIndex >= 0) {
				this.suffix = this.suffix.slice(0, suffixIndex + 1);
				this.suffix[this.suffix.length - 1] = { ...this.suffix.at(-1)!, endCol: target.endCol };
				this.suffix = appendUnique(this.suffix, current.slice(targetIndex + 1));
			} else {
				const baseIndex = lastMatchingRowIndex(this.baseInitialRows, target);
				if (baseIndex >= 0) {
					this.restoreInitialSelection();
					this.initialRows[baseIndex] = { ...this.initialRows[baseIndex], endCol: target.endCol };
					this.refreshInitialText();
					const lastInitial = this.initialRows.at(-1);
					const lastVisibleIndex = lastInitial
						? lastMatchingRowIndex(current, lastInitial)
						: targetIndex;
					this.suffix = appendUnique(this.suffix, current.slice(lastVisibleIndex + 1));
				} else {
					this.suffix = appendUnique(this.suffix, current.slice(targetIndex + 1));
				}
			}
		} else {
			const prefixIndex = this.prefix.findIndex((row) => rowKey(row) === rowKey(target));
			if (prefixIndex >= 0) {
				this.prefix = this.prefix.slice(prefixIndex);
				this.prefix[0] = { ...this.prefix[0], startCol: target.startCol };
				this.prefix = appendUnique(current.slice(0, targetIndex), this.prefix);
			} else {
				const baseIndex = this.baseInitialRows.findIndex((row) => rowKey(row) === rowKey(target));
				if (baseIndex >= 0) {
					this.restoreInitialSelection();
					this.initialRows[baseIndex] = { ...this.initialRows[baseIndex], startCol: target.startCol };
					this.refreshInitialText();
					const firstInitial = this.initialRows[0];
					const firstVisibleIndex = firstInitial
						? current.findIndex((row) => rowKey(row) === rowKey(firstInitial))
						: targetIndex;
					this.prefix = appendUnique(current.slice(0, Math.max(0, firstVisibleIndex)), this.prefix);
				} else {
					this.prefix = appendUnique(current.slice(0, targetIndex), this.prefix);
				}
			}
		}
		this.previousSnapshot = cloneSnapshot(this.options.readSnapshot());
		this.render();
	}

	private restoreInitialSelection(): void {
		this.initialText = this.baseInitialText;
		this.initialRows = this.baseInitialRows.map((row) => ({ ...row }));
		this.initialHighlights = this.baseInitialHighlights.map((highlight) => ({ ...highlight }));
		this.initialStartsWrapped = this.baseInitialStartsWrapped;
	}

	private restoreSelectionAtAnchor(direction: -1 | 1): void {
		const anchor = this.anchorPoint;
		const row = anchor ? this.baseScreenRows.find((candidate) => candidate.row === anchor.row) : undefined;
		if (!anchor || !row) {
			this.initialText = "";
			this.initialRows = [];
			this.initialHighlights = [];
			return;
		}
		const selected = direction < 0
			? { ...row, endCol: Math.min(row.endCol, Math.max(row.startCol, anchor.col)) }
			: { ...row, startCol: Math.min(row.endCol, Math.max(row.startCol, anchor.col)) };
		this.initialRows = selected.endCol > selected.startCol ? [selected] : [];
		this.refreshInitialText();
	}

	private shrinkTowardAnchor(visibleRows: SelectableScreenRow[], direction: -1 | 1): void {
		if (direction < 0) {
			const target = visibleRows[0];
			if (!target) return;
			const baseIndex = lastMatchingRowIndex(this.baseInitialRows, target);
			if (baseIndex >= 0) {
				this.restoreInitialSelection();
				this.initialRows = this.initialRows.slice(0, baseIndex + 1);
				const endCol = target.startCol;
				if (endCol === target.startCol) this.initialRows.pop();
				else this.initialRows[this.initialRows.length - 1] = { ...this.initialRows.at(-1)!, endCol };
				this.suffix = [];
				this.refreshInitialText();
				return;
			}
			const suffixIndex = lastMatchingRowIndex(this.suffix, target);
			if (suffixIndex >= 0) {
				this.restoreInitialSelection();
				this.suffix = this.suffix.slice(0, suffixIndex + 1);
				const endCol = target.startCol;
				if (endCol === target.startCol) this.suffix.pop();
				else this.suffix[this.suffix.length - 1] = { ...this.suffix.at(-1)!, endCol };
				return;
			}
			return;
		}

		const target = visibleRows.at(-1);
		if (!target) return;
		const baseIndex = this.baseInitialRows.findIndex((row) => rowKey(row) === rowKey(target));
		if (baseIndex >= 0) {
			this.restoreInitialSelection();
			this.initialRows = this.initialRows.slice(baseIndex);
			const startCol = target.endCol;
			if (startCol === target.endCol) this.initialRows.shift();
			else this.initialRows[0] = { ...this.initialRows[0], startCol };
			this.prefix = [];
			this.refreshInitialText();
			return;
		}
		const prefixIndex = this.prefix.findIndex((row) => rowKey(row) === rowKey(target));
		if (prefixIndex >= 0) {
			this.restoreInitialSelection();
			this.prefix = this.prefix.slice(prefixIndex);
			const startCol = target.endCol;
			if (startCol === target.endCol) this.prefix.shift();
			else this.prefix[0] = { ...this.prefix[0], startCol };
			return;
		}
	}

	private refreshInitialText(): void {
		this.initialText = joinedRows(this.initialRows);
		this.initialStartsWrapped = this.initialRows[0]?.wrapped === true;
		this.initialHighlights = this.initialRows.map(({ row, startCol, endCol }) => ({ row, startCol, endCol }));
	}

	private startTimer(): void {
		if (this.timer !== null || this.edgeLines === 0 || this.phase !== "active") return;
		const setTimer = this.options.setInterval ?? setInterval;
		this.timer = setTimer(() => this.tick(), SELECTION_SCROLL_INTERVAL_MS);
	}

	private tick(): void {
		if (this.phase !== "active" || this.edgeLines === 0) return;
		this.direction = Math.sign(this.edgeLines) as -1 | 1;
		this.scrollRequested = this.options.scroll(this.direction, Math.abs(this.edgeLines)) !== false;
	}

	private render(): void {
		if (this.phase !== "active" && this.phase !== "complete") return;
		if (this.showInitialHighlights) {
			this.options.render({ highlights: this.initialHighlights });
			return;
		}
		const selectedRows = new Map<string, SelectableScreenRow[]>();
		for (const row of [...this.prefix, ...this.initialRows, ...this.suffix]) {
			const key = rowKey(row);
			const matches = selectedRows.get(key) ?? [];
			matches.push(row);
			selectedRows.set(key, matches);
		}
		const highlights = selectableScreenRows(this.previousSnapshot ?? this.options.readSnapshot()).flatMap((row) => {
			const key = rowKey(row);
			const selected = selectedRows.get(key)?.shift();
			if (!selected) return [];
			const highlight = {
				row: row.row,
				startCol: Math.max(row.startCol, selected.startCol),
				endCol: Math.min(row.endCol, selected.endCol),
			};
			return highlight.endCol > highlight.startCol ? [highlight] : [];
		});
		this.options.render({ highlights });
	}

	private stopTimer(): void {
		if (this.timer === null) return;
		(this.options.clearInterval ?? clearInterval)(this.timer);
		this.timer = null;
	}

	private reset(): void {
		this.stopTimer();
		this.phase = "idle";
		this.edgeLines = 0;
		this.initialText = "";
		this.initialRows = [];
		this.initialHighlights = [];
		this.initialStartsWrapped = false;
		this.baseInitialText = "";
		this.baseInitialRows = [];
		this.baseInitialHighlights = [];
		this.baseInitialStartsWrapped = false;
		this.baseScreenRows = [];
		this.anchorPoint = null;
		this.prefix = [];
		this.suffix = [];
		this.previousSnapshot = null;
		this.showInitialHighlights = false;
		this.insideFocus = null;
		this.trimmingToAnchor = false;
		this.scrollRequested = false;
		this.options.render(null);
	}
}
