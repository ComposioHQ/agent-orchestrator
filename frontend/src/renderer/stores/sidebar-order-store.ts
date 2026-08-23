import { create } from "zustand";

/**
 * Persisted manual order for the sidebar tree: which projects come first, and
 * how sessions are arranged inside each project.
 *
 * This is a renderer-only view preference, so it lives in the same place as the
 * sidebar's other layout state (`ao-sidebar-w`, `ao.sidebar.open`, theme) —
 * localStorage, which Electron keeps under `~/.ao/electron` because `main.ts`
 * pins `userData` there. Nothing outside the renderer reads it, so it does not
 * belong in `ui-settings.json` (main-process-visible prefs like locale and
 * sound) and it is not a daemon fact: the daemon returns projects and sessions,
 * never a display order.
 */

const storageKey = "ao.sidebar.order";
/** Bumped only if the stored shape changes; a mismatch falls back to defaults. */
const storageVersion = 1;

type PersistedSidebarOrder = {
	version: number;
	projects: string[];
	sessionsByProject: Record<string, string[]>;
};

export type SidebarOrderState = {
	/** Explicitly placed project ids, first to last. */
	projectOrder: string[];
	/** Explicitly placed session ids per project id, first to last. */
	sessionOrderByProject: Record<string, string[]>;
	setProjectOrder: (projectIds: string[]) => void;
	setSessionOrder: (projectId: string, sessionIds: string[]) => void;
};

type StoredOrder = Pick<SidebarOrderState, "projectOrder" | "sessionOrderByProject">;

function getLocalStorage(): Storage | null {
	if (typeof window === "undefined" || !window.localStorage) return null;
	return window.localStorage;
}

function stringIds(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.every((entry) => typeof entry === "string") ? (value as string[]) : null;
}

/**
 * Read the persisted order, tolerating absent, corrupt, or foreign-versioned
 * data by falling back to "no manual order" (the derived sidebar order).
 */
export function readStoredSidebarOrder(): StoredOrder {
	const empty: StoredOrder = { projectOrder: [], sessionOrderByProject: {} };
	const raw = getLocalStorage()?.getItem(storageKey);
	if (!raw) return empty;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return empty;
	}
	if (typeof parsed !== "object" || parsed === null) return empty;
	const candidate = parsed as Partial<PersistedSidebarOrder>;
	if (candidate.version !== storageVersion) return empty;
	const sessionOrderByProject: Record<string, string[]> = {};
	for (const [projectId, ids] of Object.entries(candidate.sessionsByProject ?? {})) {
		const sessionIds = stringIds(ids);
		if (sessionIds) sessionOrderByProject[projectId] = sessionIds;
	}
	return { projectOrder: stringIds(candidate.projects) ?? [], sessionOrderByProject };
}

function writeStoredSidebarOrder(order: StoredOrder): void {
	const payload: PersistedSidebarOrder = {
		version: storageVersion,
		projects: order.projectOrder,
		sessionsByProject: order.sessionOrderByProject,
	};
	try {
		getLocalStorage()?.setItem(storageKey, JSON.stringify(payload));
	} catch {
		// A full or disabled quota must not break reordering for this session.
	}
}

export const useSidebarOrderStore = create<SidebarOrderState>((set, get) => ({
	...readStoredSidebarOrder(),
	setProjectOrder: (projectIds) => {
		// The caller passes every project currently in the tree, so this write is
		// also the prune: session orders for projects that are gone drop out.
		const known = new Set(projectIds);
		const sessionOrderByProject = Object.fromEntries(
			Object.entries(get().sessionOrderByProject).filter(([projectId]) => known.has(projectId)),
		);
		const next = { projectOrder: projectIds, sessionOrderByProject };
		writeStoredSidebarOrder(next);
		set(next);
	},
	setSessionOrder: (projectId, sessionIds) => {
		const next = {
			projectOrder: get().projectOrder,
			sessionOrderByProject: { ...get().sessionOrderByProject, [projectId]: sessionIds },
		};
		writeStoredSidebarOrder(next);
		set({ sessionOrderByProject: next.sessionOrderByProject });
	},
}));

/**
 * Re-read the persisted order into the store — what renderer boot does
 * implicitly on first import, exposed so a reload can be exercised directly.
 */
export function hydrateSidebarOrderFromStorage(): void {
	useSidebarOrderStore.setState(readStoredSidebarOrder());
}
