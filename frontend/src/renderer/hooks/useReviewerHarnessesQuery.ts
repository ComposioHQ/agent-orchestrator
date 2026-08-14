import { useQuery } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { AgentCatalog } from "./useAgentsQuery";

// GET /api/v1/reviewer-harnesses reuses the agent inventory contract
// (AgentCatalog === ListAgentsResponse), filtered server-side to harnesses
// that are also valid reviewers, so this hook's shape and staleness policy
// mirror useAgentsQuery on purpose.
export const reviewerHarnessesQueryKey = ["reviewer-harnesses"] as const;

async function fetchReviewerHarnesses(): Promise<AgentCatalog> {
	const { data, error } = await apiClient.GET("/api/v1/reviewer-harnesses");
	if (error) throw new Error(apiErrorMessage(error));
	return data as AgentCatalog;
}

export const reviewerHarnessesQueryOptions = {
	queryKey: reviewerHarnessesQueryKey,
	queryFn: fetchReviewerHarnesses,
	retry: 1,
	staleTime: 5 * 60 * 1000,
};

export function useReviewerHarnessesQuery() {
	return useQuery(reviewerHarnessesQueryOptions);
}
