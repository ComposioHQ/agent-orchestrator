import type { QueryClient } from "@tanstack/react-query";
import type { Ref } from "./hosts";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { SessionMode } from "../types/conversation";
import { OrchestratorSpawnError, spawnOrchestrator } from "./spawn-orchestrator";
import type { OrchestratorReplacementFailure } from "../stores/ui-store";

type NavigateToSession = (options: {
	to: "/host/$hostId/session/$sessionId";
	params: { hostId: string; sessionId: string };
}) => unknown;

type RestartProjectOrchestratorOptions = {
	project: Ref;
	queryClient: QueryClient;
	navigate: NavigateToSession;
	setProjectRestarting: (projectId: string, restarting: boolean) => void;
	setOrchestratorReplacementError: (project: Ref, failure: OrchestratorReplacementFailure | null) => void;
	onError?: (error: unknown) => void;
	mode?: SessionMode;
};

async function refreshWorkspaceState(queryClient: QueryClient) {
	try {
		await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
	} catch {
		// The restart outcome is more important than cache refresh bookkeeping:
		// callers still need navigation/error state even if refetching fails.
	}
}

export async function restartProjectOrchestrator({
	project,
	queryClient,
	navigate,
	setProjectRestarting,
	setOrchestratorReplacementError,
	onError,
	mode,
}: RestartProjectOrchestratorOptions) {
	setProjectRestarting(project.id, true);
	setOrchestratorReplacementError(project, null);
	try {
		const sessionId = await spawnOrchestrator(project.id, "restart", true, mode);
		await refreshWorkspaceState(queryClient);
		void navigate({
			to: "/host/$hostId/session/$sessionId",
			params: { hostId: project.host, sessionId },
		});
	} catch (error) {
		await refreshWorkspaceState(queryClient);
		setOrchestratorReplacementError(project, {
			message: error instanceof Error ? error.message : "Could not replace orchestrator",
			...(error instanceof OrchestratorSpawnError
				? { code: error.code, requestId: error.requestId }
				: {}),
		});
		onError?.(error);
	} finally {
		setProjectRestarting(project.id, false);
	}
}
