// Map the hosted control-plane project/session DTOs onto the same view models
// the local daemon produces.
//
// This is the whole reason a cloud project renders in the existing sidebar,
// board, and session views without a forked component: the difference between
// local and cloud stops here, at the mapper, and everything downstream sees one
// WorkspaceSummary[] whose rows differ only by `location`.

import type { CloudClient, Project, Session } from "@aoagents/cloud-client";
import type { CloudOrganization } from "../../shared/cloud-account";
import {
	toAgentProvider,
	toSessionActivity,
	toSessionStatus,
	type WorkspaceSession,
	type WorkspaceSummary,
} from "../types/workspace";

// One page is plenty for early access and keeps a single unauthorized or
// unreachable org from stalling the whole workspace read behind pagination.
const PAGE_LIMIT = 100;

export function toCloudWorkspaceSession(session: Session, project: Project): WorkspaceSession {
	return {
		id: session.id,
		location: "cloud",
		orgId: session.orgId,
		workspaceId: session.projectId,
		workspaceName: project.displayName,
		title: session.displayName || session.id,
		provider: toAgentProvider(session.harness),
		kind: session.kind,
		// The hosted contract has no interface-mode field yet (its SessionMode is
		// the approval policy), and the hosted session surface is turn/event based.
		mode: "chat",
		branch: session.branch || undefined,
		status: toSessionStatus(session.status, session.isTerminated),
		isTerminated: session.isTerminated,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		activity: toSessionActivity({ state: session.activityState, lastActivityAt: session.updatedAt }),
		prs: [],
	};
}

export function toCloudWorkspaceSummary(project: Project, sessions: Session[]): WorkspaceSummary {
	return {
		id: project.id,
		name: project.displayName,
		location: "cloud",
		orgId: project.orgId,
		// Cloud projects have no local worktree; the repository is the identity a
		// user recognizes, and it is what the project settings and the command
		// palette show in place of a path.
		path: project.repositoryUrl,
		kind: "single_repo",
		sessions: sessions
			.filter((session) => session.projectId === project.id)
			.map((session) => toCloudWorkspaceSession(session, project)),
	};
}

/**
 * Every cloud project the signed-in user can reach, across all their orgs.
 *
 * A failing organization is skipped rather than propagated: an org the user was
 * removed from, or one whose region is briefly unreachable, must not take the
 * user's other cloud projects — or their local ones — off the sidebar.
 */
export async function fetchCloudWorkspaces(
	client: CloudClient,
	organizations: readonly CloudOrganization[],
	signal?: AbortSignal,
): Promise<WorkspaceSummary[]> {
	const perOrg = await Promise.all(
		organizations.map(async (organization) => {
			try {
				const [projects, sessions] = await Promise.all([
					client.listProjects(organization.id, { limit: PAGE_LIMIT, signal }),
					client.listSessions(organization.id, { limit: PAGE_LIMIT, signal }),
				]);
				return projects.items.map((project) => toCloudWorkspaceSummary(project, sessions.items));
			} catch {
				return [];
			}
		}),
	);
	return perOrg.flat();
}
