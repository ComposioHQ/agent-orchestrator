export type SessionRouteSearch = {
	tabOwner?: string;
};

export function validateSessionRouteSearch(search: Record<string, unknown>): SessionRouteSearch {
	return {
		tabOwner: typeof search.tabOwner === "string" ? search.tabOwner : undefined,
	};
}
