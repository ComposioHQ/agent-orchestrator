import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
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
export type WorkspaceFilesResponse = components["schemas"]["ListWorkspaceFilesResponse"] & {
	compareMode?: WorkspaceCompareMode;
};

export const sessionWorkspaceFilesQueryKey = (sessionId: string) => ["session-workspace-files", sessionId] as const;
const WORKSPACE_FILES_DEGRADED_REFETCH_MS = 30_000;

async function fetchSessionWorkspaceFiles(sessionId: string, errorMessage: string): Promise<WorkspaceFilesResponse> {
	const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/workspace/files", {
		params: { path: { sessionId } },
	});
	if (error) throw new Error(apiErrorMessage(error, errorMessage));
	return (data ?? { sessionId, files: [], truncated: false }) as WorkspaceFilesResponse;
}

// Shared so SessionFilesView and SessionInspector resolve to the same cache
// entry while SSE invalidation remains the normal refresh path.
export function sessionWorkspaceFilesQueryOptions(sessionId: string, errorMessage = "Unable to load workspace files") {
	return {
		queryKey: sessionWorkspaceFilesQueryKey(sessionId),
		queryFn: () => fetchSessionWorkspaceFiles(sessionId, errorMessage),
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
