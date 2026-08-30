import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { clientFor } from "../lib/host-clients";
import { refKey, type Ref } from "../lib/hosts";
import { sessionUsageQueryRoot } from "./useSessionUsageSummaries";

export type SessionUsage = components["schemas"]["SessionUsageResponse"];

// Keyed by ref, not by bare id: two hosts can hand out the same session id, and
// a bare-id key would serve one host's usage for the other's session.
export const sessionUsageDetailQueryKey = (session: Ref) =>
	[...sessionUsageQueryRoot, "detail", refKey(session)] as const;

export async function fetchSessionUsage(session: Ref): Promise<SessionUsage> {
	const { data, error } = await clientFor(session.host).GET("/api/v1/usage/sessions/{sessionId}", {
		params: { path: { sessionId: session.id } },
	});
	if (error) throw error;
	return data;
}

export function useSessionUsage(session: Ref, enabled = true) {
	return useQuery({
		queryKey: sessionUsageDetailQueryKey(session),
		queryFn: () => fetchSessionUsage(session),
		enabled: enabled && Boolean(session.id),
		retry: 1,
	});
}
