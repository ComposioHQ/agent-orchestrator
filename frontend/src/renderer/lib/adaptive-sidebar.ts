const SIDEBAR_RELEASE_HYSTERESIS_PX = 64;

/**
 * One shell-owned decision for automatic sidebar compaction. The wider release
 * threshold prevents a resize hovering around the boundary from repeatedly
 * expanding and compacting the rail.
 */
export function adaptiveSidebarShouldCompact({
	expandedContentWidth,
	workspaceDemand,
	isCompact,
}: {
	expandedContentWidth: number;
	workspaceDemand: number | null;
	isCompact: boolean;
}): boolean {
	if (workspaceDemand === null || workspaceDemand <= 0 || expandedContentWidth <= 0) return false;
	return isCompact
		? expandedContentWidth < workspaceDemand + SIDEBAR_RELEASE_HYSTERESIS_PX
		: expandedContentWidth < workspaceDemand;
}
