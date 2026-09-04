import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type KimiSubscription = components["schemas"]["KimiSubscriptionResponse"];

export const kimiSubscriptionQueryKey = ["agents", "kimi", "subscription"] as const;

async function fetchKimiSubscription(): Promise<KimiSubscription> {
	const { data, error } = await apiClient.GET("/api/v1/agents/kimi/subscription");
	if (error || !data) throw new Error(apiErrorMessage(error, "Could not load Kimi subscription usage."));
	return data;
}

async function refreshKimiSubscription(): Promise<KimiSubscription> {
	const { data, error } = await apiClient.POST("/api/v1/agents/kimi/subscription/refresh");
	if (error || !data) throw new Error(apiErrorMessage(error, "Could not refresh Kimi subscription usage."));
	return data;
}

export function useKimiSubscriptionQuery() {
	return useQuery({ queryKey: kimiSubscriptionQueryKey, queryFn: fetchKimiSubscription, staleTime: 2 * 60_000 });
}

export function useRefreshKimiSubscription() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: refreshKimiSubscription,
		onSuccess: (data) => queryClient.setQueryData(kimiSubscriptionQueryKey, data),
	});
}
