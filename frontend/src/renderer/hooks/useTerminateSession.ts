import { type QueryClient, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSession } from "../types/workspace";
import { workspaceQueryKey } from "./useWorkspaceQuery";
import { apiErrorMessage } from "../lib/api-client";
import { clientFor } from "../lib/host-clients";
import { refKey, type Ref } from "../lib/hosts";
import { captureRendererEvent } from "../lib/telemetry";

type TerminateSessionTarget = Ref & Partial<WorkspaceSession>;

export const terminateSessionMutationKey = ["terminate-session"] as const;

type TerminateSessionMutationState = {
	error: unknown;
	session?: TerminateSessionTarget;
	status: "error" | "idle" | "pending" | "success";
	submittedAt: number;
};

function useTerminateSessionMutations() {
	return useMutationState<TerminateSessionMutationState>({
		filters: { mutationKey: terminateSessionMutationKey },
		select: (mutation) => ({
			error: mutation.state.error,
			session: mutation.state.variables as TerminateSessionTarget | undefined,
			status: mutation.state.status,
			submittedAt: mutation.state.submittedAt,
		}),
	});
}

function summarizeBySession(mutations: TerminateSessionMutationState[]) {
	const summaries = new Map<
		string,
		{ isPending: boolean; latest: TerminateSessionMutationState; session: TerminateSessionTarget }
	>();
	for (const mutation of mutations) {
		if (!mutation.session) continue;
		const key = refKey(mutation.session);
		const current = summaries.get(key);
		if (!current) {
			summaries.set(key, {
				isPending: mutation.status === "pending",
				latest: mutation,
				session: mutation.session,
			});
			continue;
		}
		current.isPending ||= mutation.status === "pending";
		if (mutation.submittedAt >= current.latest.submittedAt) current.latest = mutation;
	}
	return [...summaries.values()];
}

export function useTerminateSession() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: terminateSessionMutationKey,
		mutationFn: async (session: TerminateSessionTarget) => {
			void captureRendererEvent("ao.renderer.session_kill_requested", {
				...(session.workspaceId ? { project_id: session.workspaceId } : {}),
			});
			const { error, response } = await clientFor(session.host).POST("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId: session.id } },
			});
			if (error) {
				const fallback = response ? `Failed to terminate session (${response.status})` : "Failed to terminate session";
				throw new Error(apiErrorMessage(error, fallback));
			}
		},
		onSuccess: async (_data, session) => {
			void captureRendererEvent("ao.renderer.session_kill_succeeded", {
				...(session.workspaceId ? { project_id: session.workspaceId } : {}),
			});
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
		onError: (_error, session) => {
			void captureRendererEvent("ao.renderer.session_kill_failed", {
				...(session.workspaceId ? { project_id: session.workspaceId } : {}),
			});
		},
	});
}

export function useTerminateSessionState(ref: Ref) {
	const key = refKey(ref);
	const summary = summarizeBySession(useTerminateSessionMutations()).find(({ session }) => refKey(session) === key);

	return {
		error:
			!summary?.isPending && summary?.latest.status === "error" && summary.latest.error instanceof Error
				? summary.latest.error.message
				: null,
		isPending: summary?.isPending ?? false,
	};
}

export function useProjectTerminateSessionStates(project: Ref | undefined) {
	return summarizeBySession(useTerminateSessionMutations())
		.filter(({ isPending, latest, session }) => {
			return (
				project !== undefined &&
				session.host === project.host &&
				session.workspaceId === project.id &&
				(isPending || latest.status === "error")
			);
		})
		.sort((a, b) => b.latest.submittedAt - a.latest.submittedAt)
		.map(({ isPending, latest, session }) => ({
			error: !isPending && latest.error instanceof Error ? latest.error.message : null,
			isPending,
			session,
		}));
}

export function clearTerminateSessionState(queryClient: QueryClient, ref: Ref) {
	const key = refKey(ref);
	const mutationCache = queryClient.getMutationCache();
	for (const mutation of mutationCache.findAll({ mutationKey: terminateSessionMutationKey })) {
		const target = mutation.state.variables as TerminateSessionTarget | undefined;
		if (target && refKey(target) === key && mutation.state.status !== "pending") {
			mutationCache.remove(mutation);
		}
	}
}
