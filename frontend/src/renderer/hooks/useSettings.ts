/**
 * Daemon-owned user preferences.
 *
 * Read from and written to the daemon rather than held in the renderer, because
 * `ao spawn`, mobile, and headless spawns resolve the same value. A preference
 * kept in one client would look correct in Settings and disagree with the others.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { SessionMode } from "../types/workspace";

export const settingsQueryKey = ["settings"] as const;

export interface Settings {
	/** Applies to sessions created from now on; never to an existing one. */
	defaultSessionMode: SessionMode;
	/** Agents that can run in chat mode today. Empty means chat is unavailable. */
	chatHarnesses: string[];
	/** Deployment client identity (AO_CLIENT); empty when unset. */
	client: string;
	/** Whether the local offering is available on this daemon. */
	localEnabled: boolean;
	/** Whether the cloud offering is available (flag + entitled client + control plane). */
	cloudEnabled: boolean;
	/** Cloud control plane base URL; empty when cloud is not configured. */
	cloudControlPlaneUrl: string;
}

export function useSettings() {
	const query = useQuery({
		queryKey: settingsQueryKey,
		queryFn: async (): Promise<Settings> => {
			const { data, error } = await apiClient.GET("/api/v1/settings");
			if (error) throw error;
			return {
				defaultSessionMode: (data?.defaultSessionMode ?? "tui") as SessionMode,
				chatHarnesses: data?.chatHarnesses ?? [],
				client: data?.client ?? "",
				// Offering gates fail closed for cloud and open for local, so a daemon
				// that predates them behaves like a plain local install.
				localEnabled: data?.localEnabled ?? true,
				cloudEnabled: data?.cloudEnabled ?? false,
				cloudControlPlaneUrl: data?.cloudControlPlaneUrl ?? "",
			};
		},
	});

	return {
		settings: query.data,
		isLoading: query.isLoading,
		error: query.error ? apiErrorMessage(query.error) : undefined,
	};
}

export function useUpdateSessionInterface() {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: async (mode: SessionMode) => {
			const { data, error } = await apiClient.PATCH("/api/v1/settings/session-interface", {
				body: { defaultSessionMode: mode },
			});
			if (error) throw error;
			return data;
		},
		// Refetch rather than writing the value in locally: the daemon is the source
		// of truth, and the control must not claim a change it did not persist.
		onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsQueryKey }),
	});

	return {
		update: (mode: SessionMode) => mutation.mutate(mode),
		saving: mutation.isPending,
		error: mutation.error ? apiErrorMessage(mutation.error) : undefined,
	};
}
