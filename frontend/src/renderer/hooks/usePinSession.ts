import { useMutation, useQueryClient } from "@tanstack/react-query";
import { workspaceQueryKey } from "./useWorkspaceQuery";
import { apiErrorMessage } from "../lib/api-client";
import { clientFor } from "../lib/host-clients";
import type { Ref } from "../lib/hosts";

export const pinSessionMutationKey = ["pin-session"] as const;
export const unpinSessionMutationKey = ["unpin-session"] as const;

export function usePinSession() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: pinSessionMutationKey,
		mutationFn: async (session: Ref) => {
			const { error, response } = await clientFor(session.host).POST("/api/v1/sessions/{sessionId}/pin", {
				params: { path: { sessionId: session.id } },
			});
			if (error) {
				const fallback = response ? `Failed to pin session (${response.status})` : "Failed to pin session";
				throw new Error(apiErrorMessage(error, fallback));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
		onError: (error) => {
			console.error("Failed to pin session:", error);
		},
	});
}

export function useUnpinSession() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: unpinSessionMutationKey,
		mutationFn: async (session: Ref) => {
			const { error, response } = await clientFor(session.host).DELETE("/api/v1/sessions/{sessionId}/pin", {
				params: { path: { sessionId: session.id } },
			});
			if (error) {
				const fallback = response ? `Failed to unpin session (${response.status})` : "Failed to unpin session";
				throw new Error(apiErrorMessage(error, fallback));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
		onError: (error) => {
			console.error("Failed to unpin session:", error);
		},
	});
}
