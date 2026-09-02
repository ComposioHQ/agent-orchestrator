import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { clientFor } from "../lib/host-clients";
import { LOCAL_HOST, type HostId } from "../lib/hosts";

export type AgentReadiness = components["schemas"]["AgentReadinessResponse"];
export type AgentReadinessSnapshot = components["schemas"]["AgentReadinessSnapshot"];
export type AgentReadinessPurpose = components["schemas"]["EnsureAgentReadinessRequest"]["purpose"];

export const agentReadinessQueryKey = ["agent-readiness"] as const;
// The local host keeps the bare key so nothing that reads or invalidates
// ["agent-readiness"] today has to learn about hosts.
export const agentReadinessQueryKeyFor = (host: HostId) =>
	host === LOCAL_HOST ? agentReadinessQueryKey : ([...agentReadinessQueryKey, host] as const);

async function fetchAgentReadiness(host: HostId): Promise<AgentReadiness> {
	const { data, error } = await clientFor(host).GET("/api/v1/agents/readiness");
	if (error) throw new Error(apiErrorMessage(error));
	return data as AgentReadiness;
}

// Stays on apiClient (always local), like every other mutation: only reads
// are converted to clientFor(host) so far.
export async function ensureAgentReadiness(
	agentIds: string[] = [],
	purpose: AgentReadinessPurpose = "display",
): Promise<AgentReadiness> {
	const { data, error } = await apiClient.POST("/api/v1/agents/readiness/ensure", {
		body: { agentIds, purpose },
	});
	if (error) throw new Error(apiErrorMessage(error));
	return data as AgentReadiness;
}

export function mergeAgentReadiness(
	current: AgentReadiness | undefined,
	next: AgentReadiness,
): AgentReadiness {
	if (!current || next.agents.length === 0) return next;
	const byID = new Map(current.agents.map((agent) => [agent.id, agent]));
	for (const agent of next.agents) byID.set(agent.id, agent);
	return { agents: [...byID.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

// ensureAgentReadiness only ever probes the local daemon, so its result is
// always cached under the local host's key regardless of which host a reader
// happens to be displaying.
export function cacheAgentReadiness(queryClient: QueryClient, next: AgentReadiness): void {
	queryClient.setQueryData<AgentReadiness>(agentReadinessQueryKeyFor(LOCAL_HOST), (current) =>
		mergeAgentReadiness(current, next),
	);
}

export const agentReadinessQueryOptionsFor = (host: HostId) => ({
	queryKey: agentReadinessQueryKeyFor(host),
	queryFn: () => fetchAgentReadiness(host),
	retry: 1,
	// Freshness belongs to the daemon coordinator. React Query only retains the
	// latest display copy and must never decide whether native work is required.
	staleTime: Number.POSITIVE_INFINITY,
});

export const agentReadinessQueryOptions = agentReadinessQueryOptionsFor(LOCAL_HOST);

export function useAgentReadinessQuery(enabled = true, host: HostId = LOCAL_HOST) {
	return useQuery({ ...agentReadinessQueryOptionsFor(host), enabled });
}

export function useEnsureAgentReadiness({
	agentIds = [],
	enabled = true,
	purpose = "display",
}: {
	agentIds?: string[];
	enabled?: boolean;
	purpose?: AgentReadinessPurpose;
} = {}): void {
	const queryClient = useQueryClient();
	const agentIDsKey = [...new Set(agentIds.filter(Boolean))].sort().join("\u0000");
	const normalizedIDs = useMemo(
		() => (agentIDsKey === "" ? [] : agentIDsKey.split("\u0000")),
		[agentIDsKey],
	);

	useEffect(() => {
		if (!enabled) return;
		let active = true;
		void ensureAgentReadiness(normalizedIDs, purpose)
			.then((next) => {
				if (active) cacheAgentReadiness(queryClient, next);
			})
			.catch(() => {
				// Opportunistic: cached readiness remains useful and native launch is
				// still the authoritative validation path.
			});
		return () => {
			active = false;
		};
	}, [enabled, normalizedIDs, purpose, queryClient]);
}
