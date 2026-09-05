import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";
import { shellTerminalsQueryKey, type ShellTerminal } from "./useShellTerminals";

export type SystemRequirement = components["schemas"]["SystemRequirement"];

export const systemRequirementsQueryKey = ["system-requirements"] as const;
export const githubAuthTerminalQueryKey = ["github-auth-terminal"] as const;

async function fetchSystemRequirements(): Promise<components["schemas"]["SystemRequirementsResponse"]> {
	const { data, error } = await apiClient.GET("/api/v1/system/requirements");
	if (error || !data) throw new Error("Could not check local requirements.");
	return data;
}

async function fetchGitHubAuthRequirement(): Promise<components["schemas"]["SystemRequirement"]> {
	const { data, error } = await apiClient.GET("/api/v1/system/github-auth");
	if (error || !data) throw new Error("Could not check GitHub authentication.");
	return data;
}

export const systemRequirementsQueryOptions = {
	queryKey: systemRequirementsQueryKey,
	queryFn: fetchSystemRequirements,
	refetchOnWindowFocus: false,
	// The preview build (VITE_NO_ELECTRON) has no real daemon behind it, so
	// there is nothing to probe — mirrors isDaemonReady's short-circuit for
	// the same flag in SessionsBoard.
	enabled: !usesPreviewWorkspaceData,
};

export const githubAuthRequirementQueryOptions = {
	queryKey: ["github-auth-requirement"] as const,
	queryFn: fetchGitHubAuthRequirement,
	refetchOnWindowFocus: false,
	enabled: !usesPreviewWorkspaceData,
};

/** Advisory authentication probe. Kept separate from the startup gate because
 * credential-store access can be slow or interactive on some machines. */
export function useGitHubAuthRequirement() {
	return useQuery(githubAuthRequirementQueryOptions);
}

export function useStartGitHubAuthTerminal() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (): Promise<ShellTerminal> => {
			const { data, error } = await apiClient.POST("/api/v1/system/github-auth/terminal");
			if (error || !data) throw new Error(apiErrorMessage(error, "Could not start GitHub sign-in."));
			return data.shellTerminal;
		},
		onSuccess: (terminal) => {
			queryClient.setQueryData<ShellTerminal | null>(githubAuthTerminalQueryKey, terminal);
			queryClient.setQueryData<ShellTerminal[]>(shellTerminalsQueryKey, (current = []) => [
				...current.filter((item) => item.handleId !== terminal.handleId),
				terminal,
			]);
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		},
	});
}

/** The login PTY is intentionally app-owned rather than notice-owned. Keeping
 * its handle in query state lets the inline panel reattach after navigation
 * while the browser-based device flow is still in progress. */
export function useGitHubAuthTerminal() {
	const queryClient = useQueryClient();
	const query = useQuery<ShellTerminal | null>({
		queryKey: githubAuthTerminalQueryKey,
		queryFn: async () => null,
		enabled: false,
		initialData: null,
	});
	const clear = useCallback(() => {
		queryClient.setQueryData<ShellTerminal | null>(githubAuthTerminalQueryKey, null);
	}, [queryClient]);
	return { ...query, clear };
}

/** Single source of truth for whether the machine satisfies AO's startup
 *  requirements. Shared by SessionsBoard (which must keep the startup screen
 *  mounted while blocked) and DaemonStartupLoader (which renders the gate) so
 *  both read the same react-query cache entry and never disagree. */
export function useSystemRequirementsGate() {
	const query = useQuery(systemRequirementsQueryOptions);
	const requirements = query.data?.requirements ?? [];
	const requirementsBlocked =
		!usesPreviewWorkspaceData && query.isSuccess && requirements.some((r) => r.required && !r.satisfied);
	const checking = !usesPreviewWorkspaceData && query.isPending;
	// The board must stay behind the startup loader until the probe resolves.
	// `blocked` is the mount gate; `requirementsBlocked` is narrower and only
	// controls the dependency dialog once there is real missing-item data.
	const blocked = checking || requirementsBlocked;
	const ready = usesPreviewWorkspaceData || (query.isSuccess && !requirementsBlocked);
	// The daemon is already confirmed reachable by the time either consumer
	// mounts — if the readiness probe itself errors out, fail open rather than
	// wedging the user on the checking state forever.
	const probeFailed = query.isError;
	return { query, requirements, blocked, requirementsBlocked, checking, ready, probeFailed };
}
