import { type QueryClient, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { WorkspaceSession } from "../types/workspace";
import { agentSwitchesQueryKey, type AgentSwitch } from "./useAgentSwitches";
import { workspaceQueryKey } from "./useWorkspaceQuery";

export type SwitchAgentHarness = components["schemas"]["SwitchAgentRequest"]["targetHarness"];

export type SwitchAgentInput = {
	session: WorkspaceSession;
	targetHarness: SwitchAgentHarness;
	model: string;
	note: string;
	idempotencyKey: string;
};

export const switchAgentMutationKey = ["switch-agent"] as const;

type SwitchAgentMutationState = {
	error: unknown;
	input?: SwitchAgentInput;
	status: "error" | "idle" | "pending" | "success";
	submittedAt: number;
};

function useSwitchAgentMutations() {
	return useMutationState<SwitchAgentMutationState>({
		filters: { mutationKey: switchAgentMutationKey },
		select: (mutation) => ({
			error: mutation.state.error,
			input: mutation.state.variables as SwitchAgentInput | undefined,
			status: mutation.state.status,
			submittedAt: mutation.state.submittedAt,
		}),
	});
}

export function useSwitchAgentState(sessionId: string) {
	const mutations = useSwitchAgentMutations();
	let latest: SwitchAgentMutationState | undefined;
	let pending: SwitchAgentMutationState | undefined;
	for (const mutation of mutations) {
		if (mutation.input?.session.id !== sessionId) continue;
		if (!latest || mutation.submittedAt > latest.submittedAt) latest = mutation;
		if (
			mutation.status === "pending" &&
			(!pending || mutation.submittedAt > pending.submittedAt)
		) {
			pending = mutation;
		}
	}

	return {
		// This state describes only the POST admission request. Durable progress
		// comes from the active session summary and switch-history query.
		error:
			!pending &&
			latest?.status === "error" &&
			latest.error instanceof Error
				? latest.error.message
				: null,
		input: pending?.input,
		isPending: Boolean(pending),
	};
}

export function clearSwitchAgentState(queryClient: QueryClient, sessionId: string) {
	const mutationCache = queryClient.getMutationCache();
	for (const mutation of mutationCache.findAll({ mutationKey: switchAgentMutationKey })) {
		const input = mutation.state.variables as SwitchAgentInput | undefined;
		if (input?.session.id === sessionId && mutation.state.status !== "pending") {
			mutationCache.remove(mutation);
		}
	}
}

export function createSwitchAgentIdempotencyKey(): string {
	return crypto.randomUUID();
}

export function useSwitchAgent() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: switchAgentMutationKey,
		mutationFn: async ({ session, targetHarness, model, note, idempotencyKey }: SwitchAgentInput) => {
			const body: {
				targetHarness: SwitchAgentHarness;
				model?: string;
				note?: string;
				idempotencyKey: string;
			} = { targetHarness, idempotencyKey };
			const normalizedModel = model.trim();
			if (normalizedModel) body.model = normalizedModel;
			const normalizedNote = note.trim();
			if (normalizedNote) body.note = normalizedNote;

			const { data, error, response } = await apiClient.POST(
				"/api/v1/sessions/{sessionId}/switch-agent",
				{
					params: { path: { sessionId: session.id } },
					body,
				},
			);
			if (error || response.status !== 202 || !data?.switch) {
				const fallback = response
					? `Failed to switch agent (${response.status})`
					: "Failed to switch agent";
				throw new Error(apiErrorMessage(error, fallback));
			}
			return data.switch;
		},
		onSuccess: (agentSwitch, variables) => {
			if (!agentSwitch) return;
			queryClient.setQueryData<AgentSwitch[]>(
				agentSwitchesQueryKey(variables.session.id),
				(current = []) => [agentSwitch, ...current.filter((entry) => entry.id !== agentSwitch.id)],
			);
		},
		// Refresh both durable observers after the admission request settles.
		// The mutation itself does not represent post-admission switch progress.
		onSettled: (_data, _error, variables) => {
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			void queryClient.invalidateQueries({ queryKey: agentSwitchesQueryKey(variables.session.id) });
		},
	});
}
