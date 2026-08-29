import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "./useWorkspaceQuery";
import { codexAutomaticProfileSwitchPolicyQueryRoot } from "./codex-profile-cache";
import { cacheCodexProfiles, ensureCodexProfileCapacity } from "./useCodexProfilesQuery";

export type CodexAutomaticProfileSwitchPolicy = components["schemas"]["CodexAutomaticProfileSwitchPolicy"];
export type CodexAutomaticProfileSwitchAttempt = components["schemas"]["CodexAutomaticProfileSwitchAttempt"];

export const codexAutomaticProfileSwitchPolicyQueryKey = (sessionId: string) => [...codexAutomaticProfileSwitchPolicyQueryRoot, sessionId] as const;

async function getPolicy(sessionId: string): Promise<CodexAutomaticProfileSwitchPolicy> {
	const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/automatic-profile-switch-policy", { params: { path: { sessionId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexAutomaticProfileSwitchPolicy;
}

export function useCodexAutomaticProfileSwitchPolicy(sessionId: string, enabled: boolean, editorOpen: boolean) {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: codexAutomaticProfileSwitchPolicyQueryKey(sessionId),
		queryFn: () => getPolicy(sessionId),
		enabled: enabled && Boolean(sessionId),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const ensure = useCallback(() => {
		if (!sessionId) return;
		void ensureCodexProfileCapacity()
			.then((profiles) => {
				cacheCodexProfiles(queryClient, profiles);
				return getPolicy(sessionId);
			})
			.then((policy) => queryClient.setQueryData(codexAutomaticProfileSwitchPolicyQueryKey(sessionId), policy))
			.catch(() => undefined);
	}, [queryClient, sessionId]);
	useEffect(() => {
		if (!editorOpen) return;
		ensure();
		const onFocus = () => ensure();
		const onVisibility = () => { if (document.visibilityState === "visible") ensure(); };
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [editorOpen, ensure]);
	return { ...query, ensure };
}

export function useSaveCodexAutomaticProfileSwitchPolicy(sessionId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (input: { enabled: boolean; profileIds: string[]; expectedRevision: number }) => {
			const { data, error } = await apiClient.PUT("/api/v1/sessions/{sessionId}/automatic-profile-switch-policy", {
				params: { path: { sessionId } }, body: input,
			});
			if (error) throw new Error(apiErrorMessage(error));
			return data as CodexAutomaticProfileSwitchPolicy;
		},
		onSuccess: (policy) => {
			queryClient.setQueryData(codexAutomaticProfileSwitchPolicyQueryKey(sessionId), policy);
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
		onError: () => {
			void queryClient.fetchQuery({ queryKey: codexAutomaticProfileSwitchPolicyQueryKey(sessionId), queryFn: () => getPolicy(sessionId), staleTime: 0 });
		},
	});
}

export function useCancelCodexAutomaticProfileSwitchAttempt(sessionId: string, attemptId: string | undefined) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			if (!attemptId) throw new Error("Automatic switch attempt is unavailable");
			const { data, error } = await apiClient.POST("/api/v1/sessions/{sessionId}/automatic-profile-switch-attempts/{attemptId}/cancel", {
				params: { path: { sessionId, attemptId } },
			});
			if (error) throw new Error(apiErrorMessage(error));
			return data as CodexAutomaticProfileSwitchAttempt;
		},
		onSettled: () => void queryClient.invalidateQueries({ queryKey: workspaceQueryKey }),
	});
}
