export type TerminalTabKey = `session:${string}` | `shell:${string}` | `reviewer:${string}`;
export type ReorderableTerminalTabKey = `shell:${string}`;
export type TerminalTabGroup = "pinned" | "unpinned";

export type TerminalBarLayout = {
	pinned: ReorderableTerminalTabKey[];
	unpinned: ReorderableTerminalTabKey[];
	history: TerminalTabKey[];
};

export function emptyTerminalBarLayout(): TerminalBarLayout {
	return { pinned: [], unpinned: [], history: [] };
}

export function isReorderableTerminalTabKey(key: TerminalTabKey): key is ReorderableTerminalTabKey {
	return key.startsWith("shell:");
}

function unique<T extends string>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

export function addTerminalTab(
	layout: TerminalBarLayout,
	key: TerminalTabKey,
	ownerKey: TerminalTabKey,
): TerminalBarLayout {
	if (
		key === ownerKey ||
		!isReorderableTerminalTabKey(key) ||
		layout.pinned.includes(key) ||
		layout.unpinned.includes(key)
	) {
		return layout;
	}
	return { ...layout, unpinned: [...layout.unpinned, key] };
}

export function activateTerminalTab(layout: TerminalBarLayout, key: TerminalTabKey): TerminalBarLayout {
	return { ...layout, history: [...layout.history.filter((candidate) => candidate !== key), key] };
}

export function setTerminalTabPinned(
	layout: TerminalBarLayout,
	key: ReorderableTerminalTabKey,
	pinned: boolean,
): TerminalBarLayout {
	const exists = layout.pinned.includes(key) || layout.unpinned.includes(key);
	if (!exists || layout.pinned.includes(key) === pinned) return layout;
	return pinned
		? {
				...layout,
				pinned: [...layout.pinned, key],
				unpinned: layout.unpinned.filter((candidate) => candidate !== key),
			}
		: {
				...layout,
				pinned: layout.pinned.filter((candidate) => candidate !== key),
				unpinned: [key, ...layout.unpinned],
			};
}

export function reorderTerminalTabs(
	layout: TerminalBarLayout,
	group: TerminalTabGroup,
	keys: readonly ReorderableTerminalTabKey[],
): TerminalBarLayout {
	const current = layout[group];
	const currentSet = new Set(current);
	const reordered = unique(keys.filter((key) => currentSet.has(key)));
	for (const key of current) {
		if (!reordered.includes(key)) reordered.push(key);
	}
	return { ...layout, [group]: reordered };
}

export function resolveTerminalTabLayout(
	layout: TerminalBarLayout,
	availableKeys: readonly TerminalTabKey[],
	ownerKey: TerminalTabKey,
): TerminalBarLayout {
	const available = new Set(availableKeys);
	const pinned = unique(layout.pinned.filter((key) => available.has(key)));
	const claimed = new Set<ReorderableTerminalTabKey>(pinned);
	const unpinned = unique(layout.unpinned.filter((key) => available.has(key) && !claimed.has(key)));
	for (const key of availableKeys) {
		if (key !== ownerKey && isReorderableTerminalTabKey(key) && !claimed.has(key) && !unpinned.includes(key)) {
			unpinned.push(key);
		}
	}
	return {
		pinned,
		unpinned,
		history: unique(layout.history.filter((key) => available.has(key))),
	};
}

export function closeTerminalTab(
	layout: TerminalBarLayout,
	key: ReorderableTerminalTabKey,
	availableKeys: readonly TerminalTabKey[],
	ownerKey: TerminalTabKey,
): { layout: TerminalBarLayout; nextActiveKey: TerminalTabKey | undefined } {
	const available = new Set(availableKeys.filter((candidate) => candidate !== key));
	const history = layout.history.filter((candidate) => candidate !== key && available.has(candidate));
	return {
		layout: {
			pinned: layout.pinned.filter((candidate) => candidate !== key),
			unpinned: layout.unpinned.filter((candidate) => candidate !== key),
			history,
		},
		nextActiveKey: history.at(-1) ?? (available.has(ownerKey) ? ownerKey : undefined),
	};
}
