import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type AgentCatalog = components["schemas"]["ListAgentsResponse"];

export const agentsQueryKey = ["agents"] as const;

async function fetchAgents(): Promise<AgentCatalog> {
	const { data, error } = await apiClient.GET("/api/v1/agents");
	if (error) throw new Error(apiErrorMessage(error));
	return data as AgentCatalog;
}

export async function refreshAgents(): Promise<AgentCatalog> {
	const { data, error } = await apiClient.POST("/api/v1/agents/refresh");
	if (error) throw new Error(apiErrorMessage(error));
	return data as AgentCatalog;
}

// Full agent discovery may start every supported CLI and check its auth state.
// Keep that work off the startup path: surfaces that ask the user to pick an
// agent freshen the inventory on open instead of offering a "Refresh agents"
// link. Probing is the app's job, but only when the reader needs that catalog.
// Throttled because a probe spawns one subprocess per supported agent.
const AGENT_REFRESH_THROTTLE_MS = 5 * 60 * 1000;
let lastAgentRefreshAt = 0;

export async function refreshAgentsIfStale(): Promise<AgentCatalog | undefined> {
	const now = Date.now();
	if (now - lastAgentRefreshAt < AGENT_REFRESH_THROTTLE_MS) return undefined;
	lastAgentRefreshAt = now;
	try {
		return await refreshAgents();
	} catch {
		// Opportunistic: the cached inventory still renders, and an agent the user
		// picks anyway fails loudly at spawn time.
		return undefined;
	}
}

export const agentsQueryOptions = {
	queryKey: agentsQueryKey,
	queryFn: fetchAgents,
	retry: 1,
	staleTime: 5 * 60 * 1000,
};

export function useAgentsQuery() {
	return useQuery(agentsQueryOptions);
}
