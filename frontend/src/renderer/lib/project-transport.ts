// Per-project / per-session transport routing.
//
// A project is either local (loopback daemon) or cloud (hosted control plane).
// Nothing in the renderer switches a shared base URL between the two: the local
// api-client keeps exactly one loopback base URL for its whole lifetime, and
// every cloud-bound call resolves its transport from the project or session it
// is acting on. That is what lets local and cloud projects render side by side
// in the same sidebar, board, and session views without forking a component.
//
// The registry below is a lookup index over the workspace list the renderer
// already holds, refreshed on every successful workspace read. It is not an
// independent source of truth — call sites that hold the project or session
// object should read `location`/`orgId` from it directly, and only call sites
// that hold nothing but an id (the terminal attachment, navigation helpers)
// need the index.

export type ProjectLocation = "local" | "cloud";

export type ProjectTransport = { location: "local" } | { location: "cloud"; orgId: string };

export const LOCAL_TRANSPORT: ProjectTransport = { location: "local" };

type TransportSource = {
	id: string;
	location?: ProjectLocation;
	orgId?: string;
	sessions: Array<{ id: string }>;
};

const projectTransports = new Map<string, ProjectTransport>();
const sessionTransports = new Map<string, ProjectTransport>();

/**
 * Resolve a transport from an object that already carries its own location.
 * A cloud row with no organization is unroutable, so it degrades to local
 * rather than producing requests with an empty org path segment.
 */
export function transportOf(source: { location?: ProjectLocation; orgId?: string }): ProjectTransport {
	if (source.location !== "cloud" || !source.orgId) return LOCAL_TRANSPORT;
	return { location: "cloud", orgId: source.orgId };
}

/** Rebuild the id index from the merged workspace list. Replaces, never merges. */
export function indexWorkspaceTransports(workspaces: readonly TransportSource[]): void {
	projectTransports.clear();
	sessionTransports.clear();
	for (const workspace of workspaces) {
		const transport = transportOf(workspace);
		projectTransports.set(workspace.id, transport);
		for (const session of workspace.sessions) sessionTransports.set(session.id, transport);
	}
}

export function transportForProject(projectId: string): ProjectTransport {
	return projectTransports.get(projectId) ?? LOCAL_TRANSPORT;
}

export function transportForSession(sessionId: string): ProjectTransport {
	return sessionTransports.get(sessionId) ?? LOCAL_TRANSPORT;
}

/** Test seam: drop the index so one test's workspaces cannot leak into the next. */
export function resetWorkspaceTransports(): void {
	projectTransports.clear();
	sessionTransports.clear();
}
