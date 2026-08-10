import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient } from "../lib/api-client";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";

export type SystemRequirement = components["schemas"]["SystemRequirement"];

export const systemRequirementsQueryKey = ["system-requirements"] as const;

async function fetchSystemRequirements(): Promise<components["schemas"]["SystemRequirementsResponse"]> {
	const { data, error } = await apiClient.GET("/api/v1/system/requirements");
	if (error || !data) throw new Error("Could not check local requirements.");
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

/** Single source of truth for whether the machine satisfies AO's startup
 *  requirements. Shared by SessionsBoard (which must keep the startup screen
 *  mounted while blocked) and DaemonStartupLoader (which renders the gate) so
 *  both read the same react-query cache entry and never disagree. */
export function useSystemRequirementsGate() {
	const query = useQuery(systemRequirementsQueryOptions);
	const requirements = query.data?.requirements ?? [];
	const blocked =
		!usesPreviewWorkspaceData && query.isSuccess && requirements.some((r) => r.required && !r.satisfied);
	const ready = usesPreviewWorkspaceData || (query.isSuccess && !blocked);
	// The daemon is already confirmed reachable by the time either consumer
	// mounts — if the readiness probe itself errors out, fail open rather than
	// wedging the user on the checking state forever.
	const probeFailed = query.isError;
	return { query, requirements, blocked, ready, probeFailed };
}
