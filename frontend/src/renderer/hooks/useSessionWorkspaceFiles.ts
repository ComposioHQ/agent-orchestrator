import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { clientFor } from "../lib/host-clients";
import { refKey, type Ref } from "../lib/hosts";
import {
	getWorkspaceFileConnectionState,
	subscribeWorkspaceFileChanges,
	subscribeWorkspaceFileConnectionState,
	type WorkspaceFileConnectionState,
} from "../lib/workspace-file-events";

export type WorkspaceCompareMode = "base" | "head_fallback";
export type WorkspaceFileSummary = components["schemas"]["WorkspaceFileSummary"] & {
	previousPath?: string;
};
export type WorkspaceFileSections = components["schemas"]["WorkspaceFileSections"];
export type WorkspaceCommitSummary = components["schemas"]["WorkspaceCommitSummary"];
export type WorkspaceSummary = components["schemas"]["WorkspaceSummary"];
export type WorkspaceFilesResponse = components["schemas"]["ListWorkspaceFilesResponse"] & {
	compareMode?: WorkspaceCompareMode;
};
export type WorkspaceFileDetail = components["schemas"]["WorkspaceFileResponse"] & {
	previousPath?: string;
	compareMode?: WorkspaceCompareMode;
};

type WorkspaceSessionRef = string | Ref;

const sessionId = (session: WorkspaceSessionRef) => (typeof session === "string" ? session : session.id);
const sessionKey = (session: WorkspaceSessionRef) => (typeof session === "string" ? session : refKey(session));
const sessionClient = (session: WorkspaceSessionRef) => (typeof session === "string" ? apiClient : clientFor(session.host));

export const sessionWorkspaceFilesQueryKey = (session: WorkspaceSessionRef) =>
	["session-workspace-files", sessionKey(session)] as const;
const WORKSPACE_FILES_DEGRADED_REFETCH_MS = 30_000;

async function fetchSessionWorkspaceFiles(session: WorkspaceSessionRef, errorMessage: string): Promise<WorkspaceFilesResponse> {
	const id = sessionId(session);
	const { data, error } = await sessionClient(session).GET("/api/v1/sessions/{sessionId}/workspace/files", {
		params: { path: { sessionId: id } },
	});
	if (error) throw new Error(apiErrorMessage(error, errorMessage));
	return (data ?? {
		sessionId: id,
		files: [],
		truncated: false,
		sections: { staged: [], unstaged: [], untracked: [], committed: [] },
		commits: [],
		summary: { files: 0, additions: 0, deletions: 0 },
	}) as WorkspaceFilesResponse;
}

export const sessionWorkspaceFileQueryKey = (session: WorkspaceSessionRef, path: string) =>
	["session-workspace-file", sessionKey(session), path] as const;

async function fetchSessionWorkspaceFile(
	session: WorkspaceSessionRef,
	path: string,
	errorMessage: string,
): Promise<WorkspaceFileDetail> {
	const { data, error } = await sessionClient(session).GET("/api/v1/sessions/{sessionId}/workspace/file", {
		params: { path: { sessionId: sessionId(session) }, query: { path } },
	});
	if (error) throw new Error(apiErrorMessage(error, errorMessage));
	if (!data) throw new Error(errorMessage);
	return data as WorkspaceFileDetail;
}

// Shared so the diff view (expand-on-demand) and the plain read-only viewer
// always resolve to the same cache entry for a given (session, path).
export function sessionWorkspaceFileQueryOptions(
	session: WorkspaceSessionRef,
	path: string,
	errorMessage = "Unable to load workspace file",
) {
	return {
		queryKey: sessionWorkspaceFileQueryKey(session, path),
		queryFn: () => fetchSessionWorkspaceFile(session, path, errorMessage),
	};
}

// Shared so SessionFileExplorer and SessionInspector resolve to the same cache
// entry while SSE invalidation remains the normal refresh path.
export function sessionWorkspaceFilesQueryOptions(
	session: WorkspaceSessionRef,
	errorMessage = "Unable to load workspace files",
) {
	return {
		queryKey: sessionWorkspaceFilesQueryKey(session),
		queryFn: () => fetchSessionWorkspaceFiles(session, errorMessage),
	};
}

export function workspaceFilesRefetchInterval(state: WorkspaceFileConnectionState): false | number {
	return state === "degraded" ? WORKSPACE_FILES_DEGRADED_REFETCH_MS : false;
}

export function useWorkspaceFileConnectionState(sessionId: string): WorkspaceFileConnectionState {
	const subscribe = useCallback(
		(listener: () => void) => subscribeWorkspaceFileConnectionState(sessionId, listener),
		[sessionId],
	);
	const getSnapshot = useCallback(() => getWorkspaceFileConnectionState(sessionId), [sessionId]);
	return useSyncExternalStore(subscribe, getSnapshot);
}

export function isChangedWorkspaceFile(file: WorkspaceFileSummary): boolean {
	return file.status !== "unmodified";
}

// Keep the lightweight summary query warm while the inspector is open. The
// Files view then mounts against current cache data instead of flashing a
// misleading zero while its first request starts.
export function useSessionWorkspaceFilesChangedCount(sessionId: string | undefined): number | undefined {
	const queryClient = useQueryClient();
	const query = useQuery({
		...sessionWorkspaceFilesQueryOptions(sessionId ?? ""),
		enabled: Boolean(sessionId),
		// Live invalidations keep the inactive tab fresh; polling starts only
		// when the full Files view is visible.
		refetchInterval: false,
		select: (data: WorkspaceFilesResponse) => data.files.filter(isChangedWorkspaceFile).length,
	});
	useEffect(() => {
		if (!sessionId) return;
		return subscribeWorkspaceFileChanges(sessionId, queryClient);
	}, [queryClient, sessionId]);
	return sessionId ? query.data : undefined;
}
