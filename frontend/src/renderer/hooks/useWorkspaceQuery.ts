import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, hasTrustedApiBaseUrl } from "../lib/api-client";
import { mockWorkspaces } from "../lib/mock-data";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";
import { toReviewerHarnessId } from "../lib/reviewer-harnesses";
import { captureRendererEvent } from "../lib/telemetry";
import { aoBridge } from "../lib/bridge";
import {
	type AgentSwitchSummary,
	type PRState,
	type PullRequestFacts,
	toAgentProvider,
	toProjectKind,
	toSessionActivity,
	toSessionStatus,
	type WorkspaceSummary,
} from "../types/workspace";

function toAgentSwitchSummary(
	agentSwitch: components["schemas"]["AgentSwitch"],
): AgentSwitchSummary {
	return {
		agentHandoffStatus: agentSwitch.agentHandoffStatus,
		errorCode: agentSwitch.errorCode,
		fromHarness: agentSwitch.fromHarness,
		id: agentSwitch.id,
		state: agentSwitch.state,
		targetHarness: agentSwitch.targetHarness,
	};
}

function toPullRequestFacts(pr: components["schemas"]["SessionPRFacts"]): PullRequestFacts {
	return {
		url: pr.url,
		number: pr.number,
		state: pr.state as PRState,
		ci: pr.ci,
		review: pr.review,
		mergeability: pr.mergeability,
		reviewComments: pr.reviewComments,
		updatedAt: pr.updatedAt,
	};
}

export const workspaceQueryKey = ["workspaces"] as const;
export const cloudWorkspaceQueryKey = ["cloud-workspaces"] as const;
const reportedUnknownSessionFields = new Set<string>();

function reportUnknownSessionField(field: "status" | "activity", value?: string): void {
	const reason = value ? "unrecognized" : "missing";
	const key = `${field}:${reason}`;
	if (reportedUnknownSessionFields.has(key)) return;
	reportedUnknownSessionFields.add(key);
	void captureRendererEvent("ao.renderer.session_state_unknown", { field, reason });
}

// e2e seam (dev:web only): the Playwright fake-agent harness injects
// `window.__aoFakeAgent` (see e2e/support/fake-bridge.ts) to drive a
// deterministic, mutable session timeline off the SSE refetch path. Compiled
// out of the packaged build — the packaged renderer never sets VITE_NO_ELECTRON
// and always hits the real daemon.
type FakeAgentSeam = { snapshot: () => WorkspaceSummary[] };

async function fetchWorkspaces(): Promise<WorkspaceSummary[]> {
	if (usesPreviewWorkspaceData) {
		const fake =
			typeof window !== "undefined"
				? (window as unknown as { __aoFakeAgent?: FakeAgentSeam }).__aoFakeAgent
				: undefined;
		return fake ? fake.snapshot() : mockWorkspaces;
	}
	if (!hasTrustedApiBaseUrl()) {
		throw new Error("AO daemon API is not ready");
	}

	const [{ data: projectsData, error: projectsError }, { data: sessionsData, error: sessionsError }] =
		await Promise.all([apiClient.GET("/api/v1/projects"), apiClient.GET("/api/v1/sessions")]);

	if (projectsError || sessionsError) throw projectsError ?? sessionsError;

	return (projectsData?.projects ?? []).map((project) => {
		const kind = toProjectKind(project.kind);
		return {
			id: project.id,
			name: project.name,
			kind,
			path: project.path,
			orchestratorAgent: project.orchestratorAgent ? toAgentProvider(project.orchestratorAgent) : undefined,
			sessions: (sessionsData?.sessions ?? [])
				.filter((session) => session.projectId === project.id)
				.map((session) => {
					const status = toSessionStatus(session.status, session.isTerminated);
					const scmStatus = session.scmStatus ? toSessionStatus(session.scmStatus) : undefined;
					const activity = toSessionActivity(session.activity);
					if (status === "unknown") reportUnknownSessionField("status", session.status);
					if (!activity || activity.state === "unknown") {
						reportUnknownSessionField("activity", session.activity?.state);
					}
					return {
						id: session.id,
						terminalHandleId: session.terminalHandleId,
						workspaceId: project.id,
						workspaceName: project.name,
						title: session.displayName ?? session.issueId ?? session.id,
						issueId: session.issueId,
						provider: toAgentProvider(session.harness),
						reviewerHarness: toReviewerHarnessId(session.reviewerHarness),
						autoReviewEnabled: session.autoReviewEnabled ?? false,
						kind: session.kind === "orchestrator" ? "orchestrator" : session.kind === "worker" ? "worker" : undefined,
						// Carried through verbatim: the session surface must render from
						// the mode this session was created with, not from whatever the
						// current default happens to be.
						mode: session.mode === "chat" ? "chat" : "tui",
						branch: session.branch || undefined,
						status,
						scmStatus,
						isTerminated: session.isTerminated,
						terminateOnPrMerge: session.terminateOnPrMerge ?? false,
						autoInjectReview: session.autoInjectReview ?? true,
						autoInjectCI: session.autoInjectCI ?? true,
						createdAt: session.createdAt,
						updatedAt: session.updatedAt,
						activity,
						activeAgentSwitch: session.activeAgentSwitch
							? toAgentSwitchSummary(session.activeAgentSwitch)
							: undefined,
						previewUrl: session.previewUrl,
						previewRevision: session.previewRevision,
						isPinned: session.isPinned ?? false,
						pinnedAt: session.pinnedAt ?? undefined,
						prs: (session.prs ?? []).map(toPullRequestFacts),
					};
				}),
		};
	});
}

async function fetchCloudWorkspaces(): Promise<WorkspaceSummary[]> {
	if (!(await aoBridge.cloud.isBetaEnabled())) return [];
	try {
		const overview = await aoBridge.cloud.getOverview();
		return overview.projects.map((project) => {
			const sessions = overview.sessions.filter((session) => session.projectId === project.id);
			const orchestrator = sessions.find((session) => session.kind === "orchestrator");
			const orchestratorAgent = orchestrator?.harness ?? project.config?.orchestrator?.agent;
			return {
				id: project.id,
				executionLocation: "cloud" as const,
				cloudOrgId: project.orgId,
				name: project.displayName,
				kind: "single_repo" as const,
				path: project.repositoryUrl,
				orchestratorAgent: orchestratorAgent ? toAgentProvider(orchestratorAgent) : undefined,
				sessions: sessions.map((session) => ({
					id: session.id,
					executionLocation: "cloud" as const,
					workspaceId: project.id,
					workspaceName: project.displayName,
					title: session.displayName,
					provider: toAgentProvider(session.harness),
					kind: session.kind,
					mode: session.mode === "chat" ? "chat" : "tui",
					branch: session.branch || undefined,
					status: toSessionStatus(session.status, session.isTerminated),
					isTerminated: session.isTerminated,
					createdAt: session.createdAt,
					updatedAt: session.updatedAt,
					activity: session.activityState
						? toSessionActivity({ state: session.activityState })
						: undefined,
					prs: [],
				})),
			};
		});
	} catch {
		// Cloud availability must never block or hide the user's local projects.
		return [];
	}
}

// Shared so route loaders can prefetch via queryClient.ensureQueryData (paired
// with the router's defaultPreload: "intent") and the hook reads the same cache.
export const workspaceQueryOptions = {
	queryKey: workspaceQueryKey,
	queryFn: fetchWorkspaces,
	retry: 1,
	refetchInterval: 15_000,
};

export function useWorkspaceQuery() {
	const local = useQuery(workspaceQueryOptions);
	const cloud = useQuery({
		queryKey: cloudWorkspaceQueryKey,
		queryFn: fetchCloudWorkspaces,
		retry: 0,
		refetchInterval: 15_000,
	});
	return {
		...local,
		data: local.data ? [...(cloud.data ?? []), ...local.data] : local.data,
	};
}
