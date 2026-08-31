import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "./useWorkspaceQuery";

export type AutoResumeResult =
	| { status: "resumed"; resumeMode: string }
	| { status: "no_native_resume" }
	| { status: "error"; message: string };

/**
 * Attempts a native-only auto-resume of a dead terminal session's agent.
 * Returns "no_native_resume" when the adapter cannot natively continue the
 * conversation, so the caller falls back to the clean "session ended" state.
 * Tracks attempted session IDs to avoid duplicate calls.
 */
export function useAutoResumeAgent(): (sessionId: string) => Promise<AutoResumeResult> {
	const queryClient = useQueryClient();
	const attemptedRef = useRef<Set<string>>(new Set());

	return useCallback(
		async (sessionId: string) => {
			if (attemptedRef.current.has(sessionId)) {
				return { status: "no_native_resume" as const };
			}
			attemptedRef.current.add(sessionId);
			try {
				const { data, error } = await apiClient.POST("/api/v1/sessions/{sessionId}/auto-resume-agent", {
					params: { path: { sessionId } },
				});
				if (error) {
					const code = (error as { code?: string }).code;
					if (code === "SESSION_NO_NATIVE_RESUME" || code === "SESSION_NOT_RESUMABLE") {
						return { status: "no_native_resume" as const };
					}
					const message = apiErrorMessage(error, "Unable to auto-resume agent");
					return { status: "error" as const, message };
				}
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				return { status: "resumed" as const, resumeMode: data?.resumeMode ?? "native" };
			} catch (err) {
				return {
					status: "error" as const,
					message: err instanceof Error ? err.message : "Unable to auto-resume agent",
				};
			}
		},
		[queryClient],
	);
}
