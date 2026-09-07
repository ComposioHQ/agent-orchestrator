/** The board filter that means "every project". */
export const ALL_PROJECTS = "all";

/**
 * The board's project filter, checked against what the daemon actually has.
 *
 * `ao.activeProject` is restored from storage and outlives the project it
 * names: `ao project rm` on the desktop, or pairing the phone with a machine
 * whose projects differ, leaves the filter pointing at an id no session will
 * ever carry. The board then filters everything out, the spawn sheet sends the
 * dead id to the daemon and shows its 404, and nothing says the board is
 * filtered: the switcher is hidden below two projects and Settings labelled the
 * stale id "All projects" because its lookup missed (#4843).
 *
 * Returns the filter to apply: the id when the daemon lists it, "all" when it
 * does not. Pure so the store can derive from it and the sheet can re-check
 * its seed with the same rule.
 */
export function resolveActiveProject(activeProjectId: string, projects: readonly { id: string }[]): string {
	if (activeProjectId === ALL_PROJECTS) return ALL_PROJECTS;
	// An empty list is not evidence. It is the state before the first fetch,
	// and getSessions swallows a failed /projects into [] so the board can still
	// render — judging against either would drop a valid filter. A daemon with
	// no projects has no sessions to filter, so nothing is lost by waiting for
	// a list that names something.
	if (projects.length === 0) return activeProjectId;
	return projects.some((p) => p.id === activeProjectId) ? activeProjectId : ALL_PROJECTS;
}

/**
 * What to call the filter wherever a name is shown. The id stands in while the
 * list is empty (see resolveActiveProject): it is what the user typed to create
 * the project, and it is honest — the "All projects" that used to fill the gap
 * is what hid the stale filter from the reporter.
 */
export function activeProjectLabel(activeProjectId: string, projects: readonly { id: string; name: string }[]): string {
	if (activeProjectId === ALL_PROJECTS) return "All projects";
	return projects.find((p) => p.id === activeProjectId)?.name ?? activeProjectId;
}

/**
 * Copy for the board's empty state when the filter, not the fleet, is why
 * nothing is listed. Says so and counts what "Show all projects" would put on
 * the board; the archive is collapsed there, so archived-only gets its own
 * sentence rather than "0 agents".
 */
export function filteredEmptyCopy(projectLabel: string, hidden: { live: number; archived: number }): { title: string; message: string } {
	const rest =
		hidden.live > 0
			? `${hidden.live === 1 ? "1 agent is" : `${hidden.live} agents are`} in other projects.`
			: "Other projects have only archived sessions.";
	return { title: "No agents in this project", message: `Filtered to ${projectLabel}. ${rest}` };
}
