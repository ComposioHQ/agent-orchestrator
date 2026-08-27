import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { ConversationSnapshot } from "../types/conversation";
import { toSnapshot, type ConversationSendInput } from "./useConversation";

type WireSnapshot = components["schemas"]["ConversationSnapshotResponse"];

export function reviewerConversationQueryKey(reviewId: string) {
	return ["reviewer-conversation", reviewId] as const;
}

export function useReviewerConversation(reviewId: string | undefined) {
	const query = useQuery({
		queryKey: reviewerConversationQueryKey(reviewId ?? ""),
		enabled: Boolean(reviewId),
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/reviews/{reviewId}/conversation", {
				params: { path: { reviewId: reviewId as string }, query: { limit: 200 } },
			});
			if (error) throw error;
			return toSnapshot(data as WireSnapshot);
		},
		refetchInterval: (query) => {
			const snapshot = query.state.data as ConversationSnapshot | undefined;
			return snapshot?.controller.state === "busy" ? 500 : 2_000;
		},
	});
	return {
		snapshot: query.data,
		isLoading: query.isLoading,
		error: query.error ? apiErrorMessage(query.error) : undefined,
	};
}

export function useReviewerConversationCommands(reviewId: string | undefined) {
	const queryClient = useQueryClient();
	const invalidate = useCallback(async () => {
		if (reviewId) await queryClient.invalidateQueries({ queryKey: reviewerConversationQueryKey(reviewId) });
	}, [queryClient, reviewId]);
	const send = useMutation({
		mutationFn: async (input: ConversationSendInput) => {
			const { data, error } = await apiClient.POST("/api/v1/reviews/{reviewId}/conversation/messages", {
				params: { path: { reviewId: reviewId as string } },
				body: { ...input, clientMessageId: crypto.randomUUID() },
			});
			if (error) throw error;
			return data;
		},
		onSuccess: invalidate,
	});
	const resolve = useMutation({
		mutationFn: async ({ requestId, decisionId }: { requestId: string; decisionId: string }) => {
			const { error } = await apiClient.POST("/api/v1/reviews/{reviewId}/conversation/approvals/{requestId}/resolve", {
				params: { path: { reviewId: reviewId as string, requestId } }, body: { decisionId },
			});
			if (error) throw error;
		}, onSuccess: invalidate,
	});
	const resolveInput = useMutation({
		mutationFn: async ({ requestId, action, content }: { requestId: string; action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }) => {
			const { error } = await apiClient.POST("/api/v1/reviews/{reviewId}/conversation/inputs/{requestId}/resolve", {
				params: { path: { reviewId: reviewId as string, requestId } }, body: { action, content },
			});
			if (error) throw error;
		}, onSuccess: invalidate,
	});
	const interrupt = useMutation({
		mutationFn: async () => {
			const { error } = await apiClient.POST("/api/v1/reviews/{reviewId}/conversation/interrupt", {
				params: { path: { reviewId: reviewId as string } },
			});
			if (error) throw error;
		}, onSettled: invalidate,
	});
	return {
		send: (input: ConversationSendInput) => send.mutateAsync(input),
		resolve: (requestId: string, decisionId: string) => resolve.mutate({ requestId, decisionId }),
		resolveInput: (requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => resolveInput.mutateAsync({ requestId, action, content }),
		interrupt: () => interrupt.mutate(),
		busy: send.isPending || resolve.isPending || resolveInput.isPending || interrupt.isPending,
		error: [send.error, resolve.error, resolveInput.error, interrupt.error].find(Boolean)
			? apiErrorMessage([send.error, resolve.error, resolveInput.error, interrupt.error].find(Boolean))
			: undefined,
	};
}
