import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { aoBridge } from "../lib/bridge";
import { sessionsAtRiskFromInstall } from "../lib/update-install-risk";
import { useUiStore } from "../stores/ui-store";
import { workspaceQueryOptions } from "./useWorkspaceQuery";
import type { WorkspaceSummary } from "../types/workspace";

/**
 * Confirm a restart-to-update only when a session would lose an in-flight turn.
 *
 * #4849 added the dialog because one click used to quit the app unasked; with
 * nothing at risk it is a modal over the Settings modal carrying no warning.
 *
 * Reads the cache instead of calling useWorkspaceQuery on purpose: that hook
 * pulls in the cloud org/session queries, which makes every test rendering the
 * sidebar or Settings supply cloud bridge mocks. Local projects only — a cloud
 * session does not die when this app quits.
 */
export function useRequestUpdateInstall(): () => void {
	const openPrompt = useUiStore((state) => state.openUpdateInstallPrompt);
	const queryClient = useQueryClient();

	return useCallback(() => {
		const projects = queryClient.getQueryData<WorkspaceSummary[]>(workspaceQueryOptions.queryKey);
		// An unresolved workspace list means AO cannot rule out a session losing a
		// turn, so it confirms. Same bias as `no_signal` inside the risk filter:
		// when liveness is unknown, assume a turn is in flight.
		if (projects === undefined) {
			openPrompt();
			return;
		}
		const atRisk = sessionsAtRiskFromInstall(projects.flatMap((project) => project.sessions));
		if (atRisk.length > 0) {
			openPrompt();
			return;
		}
		void aoBridge.updates.install();
	}, [openPrompt, queryClient]);
}
