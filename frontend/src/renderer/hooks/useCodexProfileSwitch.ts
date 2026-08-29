import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "./useWorkspaceQuery";
import { codexProfileSwitchOptionsQueryRoot } from "./codex-profile-cache";

export type CodexProfileSwitchOptions = components["schemas"]["CodexProfileSwitchOptionsResponse"];
export type CodexProfileSwitch = components["schemas"]["CodexProfileSwitch"];

export const codexProfileSwitchOptionsQueryKey = (sessionId: string) => [...codexProfileSwitchOptionsQueryRoot, sessionId] as const;

async function cachedOptions(sessionId: string): Promise<CodexProfileSwitchOptions> {
	const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/profile-switch-options", { params: { path: { sessionId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexProfileSwitchOptions;
}

export async function ensureCodexProfileSwitchOptions(sessionId: string): Promise<CodexProfileSwitchOptions> {
	const { data, error } = await apiClient.POST("/api/v1/sessions/{sessionId}/profile-switch-options/ensure", { params: { path: { sessionId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexProfileSwitchOptions;
}

export function useCodexProfileSwitchOptions(sessionId: string, open: boolean) {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: codexProfileSwitchOptionsQueryKey(sessionId),
		queryFn: () => cachedOptions(sessionId),
		enabled: open && Boolean(sessionId),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const ensure = useCallback(() => {
		if (!sessionId) return;
		void ensureCodexProfileSwitchOptions(sessionId)
			.then((options) => queryClient.setQueryData(codexProfileSwitchOptionsQueryKey(sessionId), options))
			.catch(() => undefined);
	}, [queryClient, sessionId]);
	useEffect(() => {
		if (!open) return;
		ensure();
		const onFocus = () => ensure();
		const onVisibility = () => { if (document.visibilityState === "visible") ensure(); };
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [ensure, open]);
	return { ...query, ensure };
}

export function useStartCodexProfileSwitch(sessionId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (input: { targetProfileId: string; acknowledgeUnknownCapacity: boolean }) => {
			const { data, error } = await apiClient.POST("/api/v1/sessions/{sessionId}/profile-switches", {
				params: { path: { sessionId } },
				body: { ...input, idempotencyKey: crypto.randomUUID() },
			});
			if (error) throw new Error(apiErrorMessage(error));
			return data.switch as CodexProfileSwitch;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
	});
}

export function useControlCodexProfileSwitch(sessionId: string, switchId: string | undefined) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (action: "cancel" | "recover" | "restore-source") => {
			if (!switchId) throw new Error("Profile switch is unavailable");
			const path = action === "cancel"
				? "/api/v1/sessions/{sessionId}/profile-switches/{switchId}/cancel" as const
				: action === "recover"
					? "/api/v1/sessions/{sessionId}/profile-switches/{switchId}/recover" as const
					: "/api/v1/sessions/{sessionId}/profile-switches/{switchId}/restore-source" as const;
			const { data, error } = await apiClient.POST(path, { params: { path: { sessionId, switchId } } });
			if (error) throw new Error(apiErrorMessage(error));
			return data.switch as CodexProfileSwitch;
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
	});
}
