import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "./useWorkspaceQuery";

export type SpawnFreshTerminalResult =
	| { status: "success" }
	| { status: "error"; message: string };

/**
 * Spawns a fresh login shell PTY in the existing workspace for a dead session
 * when native agent recovery is not possible.
 */
export function useSpawnFreshTerminal(): (sessionId: string) => Promise<SpawnFreshTerminalResult> {
	const queryClient = useQueryClient();
	const attemptedRef = useRef<Set<string>>(new Set());

	return useCallback(
		async (sessionId: string) => {
			if (attemptedRef.current.has(sessionId)) {
				return { status: "error" as const, message: "Fresh terminal spawn already attempted" };
			}
			attemptedRef.current.add(sessionId);
			try {
				const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/spawn-fresh-terminal", {
					params: { path: { sessionId } },
				});
				if (error) {
					const message = apiErrorMessage(error, "Unable to spawn fresh terminal");
					return { status: "error" as const, message };
				}
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				return { status: "success" as const };
			} catch (err) {
				return {
					status: "error" as const,
					message: err instanceof Error ? err.message : "Unable to spawn fresh terminal",
				};
			}
		},
		[queryClient],
	);
}
