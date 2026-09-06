import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { aoBridge } from "../lib/bridge";
import { sessionsAtRiskFromInstall } from "../lib/update-install-risk";
import { useUiStore } from "../stores/ui-store";
import { workspaceQueryOptions } from "./useWorkspaceQuery";
import type { WorkspaceSummary } from "../types/workspace";

/**
 * Decide whether restarting into a staged build needs confirming.
 *
 * The confirmation exists because a single click used to quit the app with no
 * warning (#4849). That reason only holds when a session would actually lose an
 * in-flight turn: `update-install-risk.ts` already argues that treating every
 * quit as destructive "would warn on almost every session and teach the user to
 * click through", and a confirmation carrying no warning is that same failure
 * one level up — in Settings it also stacked a modal on top of a modal.
 *
 * So confirm exactly when there is something to confirm. With nothing at risk
 * the button says "Restart & install" and does that; the build was going to
 * install on the next quit regardless.
 *
 * Reads the workspace list out of the query cache rather than subscribing with
 * useWorkspaceQuery. Both callers are mounted for the whole shell's lifetime and
 * need this only on click, and that hook pulls in the cloud session/org queries,
 * which would make every test that renders the sidebar or Settings provide cloud
 * bridge mocks it has no reason to know about. Local projects only: a cloud
 * session does not die when this desktop app quits, so it is never at risk here.
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
