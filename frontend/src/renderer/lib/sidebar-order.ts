/**
 * Manual sidebar ordering.
 *
 * The sidebar's default order is derived, not stored: projects come back in the
 * daemon's own order and worker sessions are sorted newest-updated-first. A drag
 * (or a keyboard nudge) records an explicit order for one list, and every id the
 * user has never placed keeps its derived position — appended for projects,
 * where a newly added project naturally lands last, and prepended for sessions,
 * where the derived sort already puts the newest first.
 *
 * These helpers are deliberately pure and id-based: the drag layer only ever
 * hands them ids that belong to a single list, so a session id can never rewrite
 * a project order (or another project's session order) even if a drop event
 * carried one.
 */

export type ManualOrder = readonly string[];

/**
 * Order `items` by `order`, dropping stale ids and slotting never-placed items
 * at `unplaced` while keeping their derived relative order.
 */
export function applyManualOrder<T>(
	items: readonly T[],
	idOf: (item: T) => string,
	order: ManualOrder | undefined,
	unplaced: "start" | "end",
): T[] {
	if (!order || order.length === 0) return [...items];
	const byId = new Map(items.map((item) => [idOf(item), item]));
	const placed: T[] = [];
	const seen = new Set<string>();
	for (const id of order) {
		const item = byId.get(id);
		if (item === undefined || seen.has(id)) continue;
		seen.add(id);
		placed.push(item);
	}
	const rest = items.filter((item) => !seen.has(idOf(item)));
	if (rest.length === 0) return placed;
	return unplaced === "start" ? [...rest, ...placed] : [...placed, ...rest];
}

/**
 * Move `activeId` into `overId`'s slot. Returns null — meaning "reject, change
 * nothing" — when the move is a no-op or either id is absent from `ids`. That
 * absence check is what makes a cross-project drop inert: the two ids never
 * share a list, so no order is rewritten.
 */
export function reorderById(ids: ManualOrder, activeId: string, overId: string): string[] | null {
	if (activeId === overId) return null;
	const from = ids.indexOf(activeId);
	const to = ids.indexOf(overId);
	if (from === -1 || to === -1) return null;
	return moveIndex(ids, from, to);
}

/**
 * Keyboard fallback: nudge `id` by `offset` slots. Returns null at either end of
 * the list (and for unknown ids), so arrow keys stop at the boundary instead of
 * wrapping — a session can never step out of its project this way.
 */
export function moveByOffset(ids: ManualOrder, id: string, offset: number): string[] | null {
	const from = ids.indexOf(id);
	if (from === -1) return null;
	const to = from + offset;
	if (to < 0 || to >= ids.length) return null;
	return moveIndex(ids, from, to);
}

function moveIndex(ids: ManualOrder, from: number, to: number): string[] {
	const next = [...ids];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}
