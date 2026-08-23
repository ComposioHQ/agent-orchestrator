import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isEditorId, type EditorHandoffState, type OpenTargetId } from "../../shared/editor-handoff";
import { aoBridge } from "../lib/bridge";
import { captureRendererEvent } from "../lib/telemetry";

export const editorHandoffQueryKey = (sessionId: string) => ["editor-handoff", sessionId] as const;

export function useEditorHandoffState(sessionId: string) {
	return useQuery({
		queryKey: editorHandoffQueryKey(sessionId),
		enabled: Boolean(sessionId),
		staleTime: 10_000,
		retry: false,
		queryFn: () => aoBridge.editorHandoff.getState(sessionId),
	});
}

export type OpenSessionTargetMutationInput = {
	sessionId: string;
	projectId: string;
	targetId?: OpenTargetId;
};

export function useOpenSessionTarget() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ sessionId, projectId, targetId }: OpenSessionTargetMutationInput) => {
			void captureRendererEvent("ao.renderer.open_in_editor_requested", {
				project_id: projectId,
				target_kind: targetId === "file-manager" ? "file_manager" : targetId === "terminal" ? "terminal" : "editor",
				...(targetId && isEditorId(targetId) ? { editor_id: targetId } : {}),
			});
			return aoBridge.editorHandoff.open({ sessionId, ...(targetId ? { targetId } : {}) });
		},
		onSuccess: (result, input) => {
			if (result.kind === "editor" && isEditorId(result.id)) {
				queryClient.setQueryData<EditorHandoffState>(editorHandoffQueryKey(input.sessionId), (state) =>
					state ? { ...state, preferredEditorId: result.id as typeof state.preferredEditorId } : state,
				);
			}
			void captureRendererEvent("ao.renderer.open_in_editor_succeeded", {
				project_id: input.projectId,
				target_kind: result.kind,
				...(result.kind === "editor" ? { editor_id: result.id } : {}),
			});
		},
		onError: (_error, input) => {
			void captureRendererEvent("ao.renderer.open_in_editor_failed", { project_id: input.projectId });
		},
	});
}
