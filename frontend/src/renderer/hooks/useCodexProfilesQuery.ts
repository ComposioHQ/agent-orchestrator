import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage, getApiBaseUrl } from "../lib/api-client";
import { codexProfilesQueryKey } from "./codex-profile-cache";

export { CODEX_PROFILE_DAEMON_RESET_EVENT, codexProfilesQueryKey } from "./codex-profile-cache";

export type CodexProfilesResponse = components["schemas"]["CodexProfilesResponse"];
export type CodexProfile = components["schemas"]["CodexProfileSnapshot"];
export type CodexProfileLoginStart = components["schemas"]["StartCodexProfileLoginResponse"];
export type CodexProfileLoginTerminalStart = components["schemas"]["OpenCodexProfileLoginTerminalResponse"];
export type CodexProfileLoginEvent = components["schemas"]["CodexProfileLoginEvent"];
export type CodexProfileCapacityEvent = components["schemas"]["CodexProfileCapacityEvent"];

async function fetchCodexProfiles(): Promise<CodexProfilesResponse> {
	const { data, error } = await apiClient.GET("/api/v1/agents/codex/profiles");
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexProfilesResponse;
}

export async function ensureCodexProfiles(profileIds: string[] = [], forceAuthenticationRefresh = false): Promise<CodexProfilesResponse> {
	const { data, error } = await apiClient.POST("/api/v1/agents/codex/profiles/ensure", {
		body: { profileIds, purpose: "display", ...(forceAuthenticationRefresh ? { forceAuthenticationRefresh: true } : {}) },
	});
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexProfilesResponse;
}

export async function ensureCodexProfileCapacity(profileIds: string[] = []): Promise<CodexProfilesResponse> {
	const { data, error } = await apiClient.POST("/api/v1/agents/codex/profiles/capacity/ensure", {
		body: { profileIds },
	});
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexProfilesResponse;
}

export async function createCodexProfile(label: string): Promise<CodexProfile> {
	const { data, error } = await apiClient.POST("/api/v1/agents/codex/profiles", { body: { label } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexProfile;
}

export async function startCodexProfileLogin(profileId: string): Promise<CodexProfileLoginStart> {
	const { data, error } = await apiClient.POST("/api/v1/agents/codex/profiles/{profileId}/login", {
		params: { path: { profileId } },
	});
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexProfileLoginStart;
}

export async function openCodexProfileLoginTerminal(profileId: string): Promise<CodexProfileLoginTerminalStart> {
	const { data, error } = await apiClient.POST("/api/v1/agents/codex/profiles/{profileId}/login-terminal", {
		params: { path: { profileId } },
	});
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexProfileLoginTerminalStart;
}

export async function cancelCodexProfileLogin(profileId: string, operationId: string): Promise<CodexProfileLoginEvent> {
	const { data, error } = await apiClient.POST("/api/v1/agents/codex/profiles/{profileId}/login/{operationId}/cancel", {
		params: { path: { profileId, operationId } },
	});
	if (error) throw new Error(apiErrorMessage(error));
	return data as CodexProfileLoginEvent;
}

export function cacheCodexProfiles(queryClient: QueryClient, next: CodexProfilesResponse): void {
	queryClient.setQueryData(codexProfilesQueryKey, next);
}

export function mergeCodexProfiles(queryClient: QueryClient, next: CodexProfilesResponse): void {
	queryClient.setQueryData<CodexProfilesResponse>(codexProfilesQueryKey, (current) => {
		if (!current) return next;
		const updates = new Map(next.profiles.map((profile) => [profile.id, profile]));
		const profiles = current.profiles.map((profile) => updates.get(profile.id) ?? profile);
		for (const profile of next.profiles) {
			if (!current.profiles.some((currentProfile) => currentProfile.id === profile.id)) profiles.push(profile);
		}
		return { ...current, capabilities: next.capabilities, profiles };
	});
}

export function cacheCodexProfile(queryClient: QueryClient, profile: CodexProfile): void {
	queryClient.setQueryData<CodexProfilesResponse>(codexProfilesQueryKey, (current) => {
		if (!current) return current;
		const profiles = [...current.profiles];
		const index = profiles.findIndex((item) => item.id === profile.id);
		if (index >= 0) profiles[index] = profile;
		else profiles.push(profile);
		return { ...current, profiles };
	});
}

export const codexProfilesQueryOptions = {
	queryKey: codexProfilesQueryKey,
	queryFn: fetchCodexProfiles,
	retry: 1,
	staleTime: Number.POSITIVE_INFINITY,
};

export function useCodexProfilesQuery(enabled = true) {
	return useQuery({ ...codexProfilesQueryOptions, enabled });
}

export function useEnsureCodexProfiles(enabled = true): void {
	const queryClient = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		const ensure = () => {
			const cached = queryClient.getQueryData(codexProfilesQueryKey);
			const cacheReady = cached
				? Promise.resolve()
				: queryClient.fetchQuery(codexProfilesQueryOptions).then(() => undefined).catch(() => undefined);
			void cacheReady.then(() => ensureCodexProfileCapacity()).then((next) => {
				if (active) cacheCodexProfiles(queryClient, next);
			}).catch(() => undefined);
		};
		ensure();
		const onFocus = () => ensure();
		const onVisibility = () => { if (document.visibilityState === "visible") ensure(); };
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			active = false;
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [enabled, queryClient]);
}

export function useCodexProfileLoginEvents(
	operation: Pick<CodexProfileLoginStart, "profileId" | "operationId"> | null,
	onEvent: (event: CodexProfileLoginEvent) => void,
): void {
	const queryClient = useQueryClient();
	const operationKey = operation ? `${operation.profileId}\u0000${operation.operationId}` : "";
	const stableOperation = useMemo(() => {
		if (!operationKey) return null;
		const [profileId, operationId] = operationKey.split("\u0000");
		return { profileId, operationId };
	}, [operationKey]);

	useEffect(() => {
		if (!stableOperation || typeof EventSource === "undefined") return;
		const baseUrl = getApiBaseUrl().replace(/\/+$/, "");
		if (!baseUrl) return;
		const source = new EventSource(`${baseUrl}/api/v1/agents/codex/profiles/${encodeURIComponent(stableOperation.profileId)}/login/${encodeURIComponent(stableOperation.operationId)}/events`);
		const listener = (message: MessageEvent<string>) => {
			try {
				const event = JSON.parse(message.data) as CodexProfileLoginEvent;
				if (event.profile) cacheCodexProfile(queryClient, event.profile);
				onEvent(event);
				if (event.status !== "pending") {
					source.close();
					void ensureCodexProfileCapacity()
						.then((next) => cacheCodexProfiles(queryClient, next))
						.catch(() => undefined);
				}
			} catch {
				// Ignore malformed provider state; the cached profile remains safe.
			}
		};
		source.addEventListener("codex_profile_login", listener as EventListener);
		return () => source.close();
	}, [onEvent, queryClient, stableOperation]);
}
