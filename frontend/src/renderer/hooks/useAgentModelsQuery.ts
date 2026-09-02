import { queryOptions } from "@tanstack/react-query";
import { refKey, type Ref } from "../lib/hosts";
import type { components } from "../../api/schema";
import { apiErrorMessage } from "../lib/api-client";
import { clientFor } from "../lib/host-clients";

export type AgentModelCatalog = components["schemas"]["AgentModelsResponse"];

const MODEL_CATALOG_VALIDATION_INTERVAL_MS = 10 * 60 * 1_000;

export const agentModelsQueryKey = (agentId: string, project: Ref) =>
	["agent-models", agentId, refKey(project)] as const;

async function requestAgentModels(
	agentId: string,
	project: Ref,
	mode: "cached" | "refresh" | "revalidate",
): Promise<AgentModelCatalog> {
	const path = { agent: agentId };
	const projectId = project.id;
	const client = clientFor(project.host);
	const result =
		mode === "cached"
			? await client.GET("/api/v1/agents/{agent}/models", {
					params: { path, query: { projectId: projectId || undefined } },
				})
			: await client.POST("/api/v1/agents/{agent}/models/refresh", {
					params: {
						path,
						query: { projectId: projectId || undefined, revalidate: mode === "revalidate" || undefined },
					},
				});
	if (result.error) throw new Error(apiErrorMessage(result.error));
	return result.data as AgentModelCatalog;
}

export function agentModelsQueryOptions(agentId: string, project: Ref) {
	return queryOptions({
		queryKey: agentModelsQueryKey(agentId, project),
		queryFn: () => requestAgentModels(agentId, project, "cached"),
		enabled: agentId !== "",
		staleTime: MODEL_CATALOG_VALIDATION_INTERVAL_MS,
	});
}

export function refreshAgentModels(agentId: string, project: Ref) {
	return requestAgentModels(agentId, project, "refresh");
}

export function revalidateAgentModels(agentId: string, project: Ref) {
	return requestAgentModels(agentId, project, "revalidate");
}
