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

function isReorderableTerminalTabKey(key: TerminalTabKey): key is ReorderableTerminalTabKey {
	return key.startsWith("shell:");
}

function unique<T extends string>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

export function activateTerminalTab(layout: TerminalBarLayout, key: TerminalTabKey): TerminalBarLayout {
	if (layout.history.at(-1) === key) return layout;
	return { ...layout, history: [...layout.history.filter((candidate) => candidate !== key), key] };
}

export function setTerminalTabPinned(
	layout: TerminalBarLayout,
	key: ReorderableTerminalTabKey,
	pinned: boolean,
): TerminalBarLayout {
	if (layout.pinned.includes(key) === pinned) return layout;
	return pinned
		? {
				...layout,
				pinned: [...layout.pinned, key],
				unpinned: layout.unpinned.filter((candidate) => candidate !== key),
			}
		: {
				...layout,
				pinned: layout.pinned.filter((candidate) => candidate !== key),
				unpinned: [key, ...layout.unpinned.filter((candidate) => candidate !== key)],
			};
}

export function reorderTerminalTabs(
	layout: TerminalBarLayout,
	group: TerminalTabGroup,
	keys: readonly ReorderableTerminalTabKey[],
): TerminalBarLayout {
	const current = layout[group];
	const otherGroup = new Set(group === "pinned" ? layout.unpinned : layout.pinned);
	const reordered = unique(keys.filter((key) => !otherGroup.has(key)));
	if (reordered.length === current.length && reordered.every((key, index) => key === current[index])) {
		return layout;
	}
	return { ...layout, [group]: reordered };
}

export function resolveTerminalTabLayout(
	layout: TerminalBarLayout,
	availableKeys: readonly TerminalTabKey[],
): TerminalBarLayout {
	const available = new Set(availableKeys);
	const pinned = unique(layout.pinned.filter((key) => available.has(key)));
	const claimed = new Set<ReorderableTerminalTabKey>(pinned);
	const unpinned = unique(layout.unpinned.filter((key) => available.has(key) && !claimed.has(key)));
	for (const key of availableKeys) {
		if (isReorderableTerminalTabKey(key) && !claimed.has(key) && !unpinned.includes(key)) {
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
