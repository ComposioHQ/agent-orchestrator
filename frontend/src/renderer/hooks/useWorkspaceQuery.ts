import { useQueries, useQuery, type QueryFunctionContext, type UseQueryResult } from "@tanstack/react-query";
import type { TraySessionEntry } from "../../shared/tray";
import { useMemo, useSyncExternalStore } from "react";
import { LOCAL_HOST, type HostId, type Ref } from "../lib/hosts";
import type { components } from "../../api/schema";
import { apiErrorMessage } from "../lib/api-client";
import type { CloudCpProject, CloudCpSession } from "../lib/cloud-cp";
import { clientFor, connectedHosts, hostLabelFor, isHostReady, subscribeConnectedHosts } from "../lib/host-clients";
import { hostConnectionState } from "../lib/host-events";
import { reportHostQueryFailed } from "../lib/host-telemetry";
import { mockWorkspaces } from "../lib/mock-data";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";
import { parseResponseArray } from "../lib/response-validation";
import { toReviewerHarnessId } from "../lib/reviewer-harnesses";
import { captureRendererEvent } from "../lib/telemetry";
import { useCloudCp } from "./useCloudCp";
import { useCloudOrg } from "./useCloudOrg";
import {
	type AgentSwitchSummary,
	type PRState,
	type PullRequestFacts,
	type HostSection,
	toAgentProvider,
	toKanbanColumn,
	toProjectKind,
	toSessionActivity,
	toSessionStatus,
	newestActiveOrchestrator,
	attentionZone,
	flattenHostSections,
	workerSessions,
	type WorkspaceSummary,
	type WorkspaceSession,
} from "../types/workspace";

export type { HostSection } from "../types/workspace";

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
const reportedUnknownSessionFields = new Set<string>();

export function workspaceHostQueryKey(host: HostId) {
	return [...workspaceQueryKey, host] as const;
}

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

type ProjectSummaryDTO = components["schemas"]["ProjectSummary"];
type SessionDTO = components["schemas"]["ControllersSessionView"];

function isProject(value: unknown): value is ProjectSummaryDTO {
	if (typeof value !== "object" || value === null) return false;
	const project = value as Partial<ProjectSummaryDTO>;
	return typeof project.id === "string" && typeof project.name === "string" && typeof project.path === "string";
}

function isSession(value: unknown): value is SessionDTO {
	if (typeof value !== "object" || value === null) return false;
	const session = value as Partial<SessionDTO>;
	return typeof session.id === "string" && typeof session.projectId === "string";
}

function tagWorkspaces(host: HostId, workspaces: WorkspaceSummary[]): WorkspaceSummary[] {
	return workspaces.map((workspace) => ({
		...workspace,
		host,
		sessions: workspace.sessions.map((session) => ({ ...session, host })),
	}));
}

async function fetchWorkspaces(host: HostId): Promise<WorkspaceSummary[]> {
	if (usesPreviewWorkspaceData && host === LOCAL_HOST) {
		const fake =
			typeof window !== "undefined"
				? (window as unknown as { __aoFakeAgent?: FakeAgentSeam }).__aoFakeAgent
				: undefined;
		return tagWorkspaces(host, fake ? fake.snapshot() : mockWorkspaces);
	}
	if (!isHostReady(host)) throw new Error(`host ${host} is not connected`);

	const client = clientFor(host);
	const [
		{ data: projectsData, error: projectsError, response: projectsResponse },
		{ data: sessionsData, error: sessionsError, response: sessionsResponse },
	] = await Promise.all([client.GET("/api/v1/projects"), client.GET("/api/v1/sessions")]).catch((error: unknown) => {
		if (error instanceof SyntaxError) throw new Error("Host returned malformed workspace data");
		throw error;
	});

	if (projectsError || sessionsError) {
		// The status lives on the response and nowhere else, and it is what
		// separates a rotated password (401) from a host the proxy cannot reach
		// (502). Carried on the thrown error so the caller can report it; the
		// message is precomputed from the daemon's envelope so what the user
		// reads is unchanged.
		const failed = projectsError ? projectsResponse : sessionsResponse;
		throw Object.assign(new Error(apiErrorMessage(projectsError ?? sessionsError, "Could not load projects")), {
			status: failed?.status,
		});
	}
	const projects = parseResponseArray(projectsData, "projects", isProject);
	const sessions = parseResponseArray(sessionsData, "sessions", isSession);
	if (projects === null || sessions === null) throw new Error("Host returned malformed workspace data");

	return projects.map((project) => {
		const kind = toProjectKind(project.kind);
		return {
			host,
			id: project.id,
			name: project.name,
			kind,
			path: project.path,
			orchestratorAgent: project.orchestratorAgent ? toAgentProvider(project.orchestratorAgent) : undefined,
			sessions: sessions
				.filter((session) => session.projectId === project.id)
				.map((session) => {
					const status = toSessionStatus(session.status, session.isTerminated);
					const scmStatus = session.scmStatus ? toSessionStatus(session.scmStatus) : undefined;
					const kanbanColumn = toKanbanColumn(session.kanbanColumn, status);
					const activity = toSessionActivity(session.activity);
					if (status === "unknown") reportUnknownSessionField("status", session.status);
					if (!activity || activity.state === "unknown") {
						reportUnknownSessionField("activity", session.activity?.state);
					}
					return {
						host,
						id: session.id,
						terminalHandleId: session.terminalHandleId,
						workspaceId: project.id,
						workspaceName: project.name,
						title: session.displayName ?? session.issueId ?? session.id,
						issueId: session.issueId,
						provider: toAgentProvider(session.harness),
						reviewerHarness: toReviewerHarnessId(session.reviewerHarness),
						reviewerConfig: session.reviewerConfig
							? {
								model: session.reviewerConfig.model ?? undefined,
								mode: session.reviewerConfig.mode ?? undefined,
								permissions: session.reviewerConfig.permissions ?? undefined,
							}
							: undefined,
						autoReviewEnabled: session.autoReviewEnabled ?? false,
						kind: session.kind === "orchestrator" ? "orchestrator" : session.kind === "worker" ? "worker" : undefined,
						// Carried through verbatim: the session surface must render from
						// the mode this session was created with, not from whatever the
						// current default happens to be.
						mode: session.mode === "chat" ? "chat" : "tui",
						branch: session.branch || undefined,
						status,
						scmStatus,
						kanbanColumn,
						displayStatus: session.displayStatus || undefined,
						isTerminated: session.isTerminated,
						terminateOnPrMerge: session.terminateOnPrMerge ?? false,
						autoInjectReview: session.autoInjectReview ?? true,
						autoInjectCI: session.autoInjectCI ?? true,
						createdAt: session.createdAt,
						updatedAt: session.updatedAt,
						lastUserMessageAt: session.lastUserMessageAt ?? undefined,
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

function errorStatus(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

async function fetchHostSection(host: HostId, lastGoodWorkspaces: WorkspaceSummary[] = []): Promise<HostSection[]> {
	const label = host === LOCAL_HOST ? "Local" : hostLabelFor(host);
	try {
		const workspaces = await fetchWorkspaces(host);
		// Read after the fetch, not before: this is what the sidebar shows when it
		// renders these workspaces, and a stream that dropped mid-fetch is exactly
		// the case worth catching.
		return [{ host, label, status: "ready", streamState: hostConnectionState(host), workspaces, failure: null }];
	} catch (error) {
		// Remote clients are plain openapi-fetch clients, so none of this reaches
		// api-client's ao.renderer.api_error. Without this a remote host's data
		// simply stopped loading, silently.
		reportHostQueryFailed(host, errorStatus(error));
		return [{
			host,
			label,
			status: "failed",
			streamState: hostConnectionState(host),
			workspaces: lastGoodWorkspaces,
			failure: apiErrorMessage(error, "Could not load projects"),
		}];
	}
}

function workspaceHostQueryOptions(host: HostId) {
	const queryKey = workspaceHostQueryKey(host);
	return {
		queryKey,
		queryFn: ({ client }: QueryFunctionContext<typeof queryKey>) =>
			fetchHostSection(host, client.getQueryData<HostSection[]>(queryKey)?.[0]?.workspaces),
		retry: 1,
		refetchInterval: 15_000,
	};
}

export function localWorkspaceFailure(sections: readonly HostSection[] | undefined): string | undefined {
	const local = sections?.find((section) => section.host === LOCAL_HOST);
	return local?.status === "failed" ? (local.failure ?? "Could not load projects") : undefined;
}

function combineWorkspaceQueries(results: UseQueryResult<HostSection[]>[]) {
	const local = results[0];
	const isSuccess = local?.isSuccess ?? false;
	const data = isSuccess ? results.flatMap((result) => result.data ?? []) : undefined;
	return {
		data,
		dataUpdatedAt: Math.max(0, ...results.map((result) => result.dataUpdatedAt)),
		error: local?.error ?? null,
		isError: local?.isError ?? false,
		isLoading: local?.isLoading ?? true,
		isSuccess,
		localFailure: localWorkspaceFailure(data),
		refetch: () => Promise.all(results.map((result) => result.refetch())),
	};
}

// Shared so route loaders can prefetch the local host via
// queryClient.ensureQueryData and the hook reads the same cache.
export const workspaceQueryOptions = workspaceHostQueryOptions(LOCAL_HOST);

// Cloud projects are separate from daemon hosts, but share the local section:
// they cannot be queried through a remote daemon client and their sessions use
// the control-plane terminal transport.
export const cloudProjectsQueryKey = ["cloud-projects"] as const;
export const cloudSessionsQueryKey = ["cloud-sessions"] as const;

function toCloudWorkspaceSession(
	session: CloudCpSession,
	project: CloudCpProject,
	orgId: string,
): WorkspaceSession {
	return {
		host: LOCAL_HOST,
		id: session.id,
		terminalHandleId: session.id,
		workspaceId: project.id,
		workspaceName: project.displayName,
		title: session.displayName || session.id,
		provider: toAgentProvider(session.harness),
		kind: session.kind === "orchestrator" ? "orchestrator" : "worker",
		branch: session.branch || undefined,
		status: toSessionStatus(session.status, session.isTerminated),
		isTerminated: session.isTerminated,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		activity: toSessionActivity({ state: session.activityState }),
		prs: [],
		cloud: { orgId },
	};
}

function toCloudWorkspace(
	project: CloudCpProject,
	sessions: CloudCpSession[],
	orgId: string,
): WorkspaceSummary {
	return {
		host: LOCAL_HOST,
		id: project.id,
		name: project.displayName,
		kind: "cloud",
		path: "",
		sessions: sessions
			.filter((session) => session.projectId === project.id)
			.map((session) => toCloudWorkspaceSession(session, project, orgId)),
	};
}

type WorkspaceSubscriptionOptions = {
	subscribed?: boolean;
};

export function useCloudProjectsQuery(options: WorkspaceSubscriptionOptions = {}) {
	const { client, ready, baseUrl } = useCloudCp();
	const { org } = useCloudOrg();
	const orgId = org?.id;
	return useQuery({
		queryKey: [...cloudProjectsQueryKey, baseUrl, orgId ?? ""],
		enabled: ready && orgId !== undefined,
		subscribed: options.subscribed,
		retry: 1,
		queryFn: async (): Promise<CloudCpProject[]> => {
			if (orgId === undefined) return [];
			const response = await client.listProjects(orgId, { limit: 100 });
			return response.items;
		},
	});
}

export function useCloudSessionsQuery(options: WorkspaceSubscriptionOptions = {}) {
	const { client, ready, baseUrl } = useCloudCp();
	const { org } = useCloudOrg();
	const orgId = org?.id;
	return useQuery({
		queryKey: [...cloudSessionsQueryKey, baseUrl, orgId ?? ""],
		enabled: ready && orgId !== undefined,
		subscribed: options.subscribed,
		retry: 1,
		refetchInterval: 5000,
		queryFn: async (): Promise<CloudCpSession[]> => {
			if (orgId === undefined) return [];
			const response = await client.listSessions(orgId, { limit: 100 });
			return response.items;
		},
	});
}

export function useWorkspaceQuery(options: WorkspaceSubscriptionOptions = {}) {
	const remotes = useSyncExternalStore(subscribeConnectedHosts, connectedHosts, connectedHosts);
	const hostQueries = useQueries({
		queries: [LOCAL_HOST, ...remotes].map((host) => ({
			...workspaceHostQueryOptions(host),
			subscribed: options.subscribed,
		})),
		combine: combineWorkspaceQueries,
	});
	const cloud = useCloudProjectsQuery(options);
	const cloudSessions = useCloudSessionsQuery(options);
	const { org, ready } = useCloudOrg();
	const orgId = org?.id;
	const data = useMemo(() => {
		const sections = hostQueries.data;
		const projects = cloud.data;
		if (sections === undefined || projects === undefined || projects.length === 0 || !ready || orgId === undefined) {
			return sections;
		}
		const sessions = cloudSessions.data ?? [];
		const cloudWorkspaces = projects.map((project) => toCloudWorkspace(project, sessions, orgId));
		return sections.map((section) =>
			section.host === LOCAL_HOST
				? { ...section, workspaces: [...section.workspaces, ...cloudWorkspaces] }
				: section,
		);
	}, [cloud.data, cloudSessions.data, hostQueries.data, orgId, ready]);
	return { ...hostQueries, data };
}

/**
 * Subscribe a detail surface to one session instead of the complete workspace
 * tree. TanStack Query applies structural sharing to the selected value, so an
 * activity update elsewhere no longer redraws the open session workspace.
 */
export function useWorkspaceSession(session: Ref) {
	const selectLocalSession = useMemo(
		() => (sections: HostSection[]) =>
			// Session ids are unique per host, not across them: matching on id
			// alone would resolve another host's same-id session here.
			flattenHostSections(sections)
				.flatMap((workspace) => workspace.sessions)
				.find((candidate) => candidate.host === session.host && candidate.id === session.id),
		[session.host, session.id],
	);
	const local = useQuery({ ...workspaceQueryOptions, select: selectLocalSession });
	const cloud = useCloudProjectsQuery();
	const cloudSessions = useCloudSessionsQuery();
	const { org, ready } = useCloudOrg();
	const cloudSession = useMemo(() => {
		if (!ready || !org?.id || !cloud.data || !cloudSessions.data) return undefined;
		// Cloud sessions always carry LOCAL_HOST (see toCloudWorkspaceSession), so
		// a bare-id match is safe here regardless of the requested session's host.
		const found = cloudSessions.data.find((candidate) => candidate.id === session.id);
		if (!found) return undefined;
		const project = cloud.data.find((candidate) => candidate.id === found.projectId);
		return project ? toCloudWorkspaceSession(found, project, org.id) : undefined;
	}, [cloud.data, cloudSessions.data, org?.id, ready, session.id]);
	return { ...local, data: local.data ?? cloudSession };
}

export type WorkspaceScope = {
	project?: Pick<WorkspaceSummary, "id" | "kind" | "name" | "orchestratorAgent">;
	session?: WorkspaceSession;
	orchestrator?: WorkspaceSession;
};

function selectWorkspaceScope(
	workspaces: WorkspaceSummary[],
	host: HostId,
	projectId: string | undefined,
	sessionId: string | undefined,
): WorkspaceScope {
	// Session and project ids are unique per host, not across them: matching on
	// id alone would resolve another host's same-id record for this scope.
	const session = sessionId
		? workspaces
				.flatMap((workspace) => workspace.sessions)
				.find((candidate) => candidate.host === host && candidate.id === sessionId)
		: undefined;
	const resolvedProjectId = session?.workspaceId ?? projectId;
	const workspace = resolvedProjectId
		? workspaces.find((candidate) => candidate.host === host && candidate.id === resolvedProjectId)
		: undefined;
	// Do not carry the project's complete sessions array into shell chrome. With
	// React Query's structural sharing, this small metadata projection retains
	// its identity when another session in the same project streams an update.
	const project = workspace
		? {
				id: workspace.id,
				kind: workspace.kind,
				name: workspace.name,
				orchestratorAgent: workspace.orchestratorAgent,
			}
		: undefined;
	return { project, session, orchestrator: workspace ? newestActiveOrchestrator(workspace.sessions) : undefined };
}

/**
 * Subscribe shell chrome to just the routed project and session. This avoids
 * redrawing the topbar for streamed activity from every other project.
 */
export function useWorkspaceScope(host: HostId, projectId?: string, sessionId?: string) {
	const selectLocalScope = useMemo(
		() => (sections: HostSection[]) => selectWorkspaceScope(flattenHostSections(sections), host, projectId, sessionId),
		[host, projectId, sessionId],
	);
	const local = useQuery({ ...workspaceQueryOptions, select: selectLocalScope });
	const cloud = useCloudProjectsQuery();
	const cloudSessions = useCloudSessionsQuery();
	const { org, ready } = useCloudOrg();
	const cloudScope = useMemo(() => {
		if (!ready || !org?.id || !cloud.data) return undefined;
		const workspaces = cloud.data.map((project) => toCloudWorkspace(project, cloudSessions.data ?? [], org.id));
		return selectWorkspaceScope(workspaces, host, projectId, sessionId);
	}, [cloud.data, cloudSessions.data, host, org?.id, projectId, ready, sessionId]);
	// Match useWorkspaceQuery's local-first semantics: do not reveal cloud
	// records before the local workspace query has resolved successfully.
	return { ...local, data: local.data ?? (local.isSuccess ? cloudScope : undefined) };
}

function selectTraySessions(workspaces: WorkspaceSummary[]): TraySessionEntry[] {
	const entries: TraySessionEntry[] = [];
	for (const workspace of workspaces) {
		for (const session of workerSessions(workspace.sessions)) {
			const zone = attentionZone(session);
			if ((zone === "merge" && session.status === "merged") || (zone !== "action" && zone !== "merge")) continue;
			entries.push({
				projectId: workspace.id,
				projectName: workspace.name,
				sessionId: session.id,
				title: session.title,
				zone,
			});
		}
	}
	return entries;
}

/**
 * The tray lives for the whole app lifetime, but only attention-worthy worker
 * sessions affect its native payload. Select that compact projection at the
 * query boundary so ordinary streamed activity does not wake the runtime.
 */
export function useWorkspaceTraySessions() {
	const local = useQuery({
		...workspaceQueryOptions,
		select: (sections: HostSection[]) => selectTraySessions(flattenHostSections(sections)),
	});
	const cloud = useCloudProjectsQuery();
	const cloudSessions = useCloudSessionsQuery();
	const { org, ready } = useCloudOrg();
	const cloudEntries = useMemo(() => {
		if (!ready || !org?.id || !cloud.data) return [];
		return selectTraySessions(cloud.data.map((project) => toCloudWorkspace(project, cloudSessions.data ?? [], org.id)));
	}, [cloud.data, cloudSessions.data, org?.id, ready]);
	const data = useMemo(() => {
		if (local.data === undefined) return undefined;
		return cloudEntries.length === 0 ? local.data : [...local.data, ...cloudEntries];
	}, [cloudEntries, local.data]);
	return { ...local, data };
}
