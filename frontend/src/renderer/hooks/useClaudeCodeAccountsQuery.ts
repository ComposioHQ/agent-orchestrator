import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { claudeCodeAccountsQueryKey, mergeClaudeCodeAccounts, writeClaudeCodeAccounts } from "./claude-code-accounts-state";

export { claudeCodeAccountsQueryKey } from "./claude-code-accounts-state";

export type ClaudeCodeAccountsResponse = components["schemas"]["ClaudeCodeAccountsResponse"];
export type ClaudeCodeAccount = components["schemas"]["ClaudeCodeAccountResponse"];
export type ClaudeCodeAccountLoginOperation = components["schemas"]["ClaudeCodeAccountLoginResponse"];
export type ClaudeCodeAccountLoginTerminalStart = components["schemas"]["OpenClaudeCodeAccountLoginTerminalResponse"];
export type ClaudeCodeActiveLogin = components["schemas"]["ClaudeCodeActiveLoginResponse"];
export type ClaudeCodeAccountSwitch = components["schemas"]["ClaudeCodeAccountSwitchResponse"];

export async function fetchClaudeCodeAccounts(): Promise<ClaudeCodeAccountsResponse> {
	const { data, error } = await apiClient.GET("/api/v1/agents/claude-code/accounts");
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountsResponse;
}

export async function ensureClaudeCodeAccounts(): Promise<ClaudeCodeAccountsResponse> {
	const { data, error } = await apiClient.POST("/api/v1/agents/claude-code/accounts/ensure");
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountsResponse;
}

export async function openClaudeCodeAccountLoginTerminal(): Promise<ClaudeCodeAccountLoginTerminalStart> {
	const { data, error } = await apiClient.POST("/api/v1/agents/claude-code/accounts/login-terminal");
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountLoginTerminalStart;
}

export async function openClaudeCodeAccountReauthenticationTerminal(accountId: string): Promise<ClaudeCodeAccountLoginTerminalStart> {
	const { data, error } = await apiClient.POST("/api/v1/agents/claude-code/accounts/{accountId}/login-terminal", { params: { path: { accountId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountLoginTerminalStart;
}

export async function verifyClaudeCodeAccountLogin(operationId: string): Promise<ClaudeCodeAccountLoginOperation> {
	const { data, error } = await apiClient.POST("/api/v1/agents/claude-code/accounts/login-operations/{operationId}/verify", { params: { path: { operationId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountLoginOperation;
}

export async function cancelClaudeCodeAccountLogin(operationId: string): Promise<ClaudeCodeAccountLoginOperation> {
	const { data, error } = await apiClient.POST("/api/v1/agents/claude-code/accounts/login-operations/{operationId}/cancel", { params: { path: { operationId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountLoginOperation;
}

export async function activateClaudeCodeAccount(accountId: string): Promise<ClaudeCodeAccountsResponse> {
	const { data, error } = await apiClient.POST("/api/v1/agents/claude-code/accounts/{accountId}/activate", { params: { path: { accountId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountsResponse;
}

export async function logoutClaudeCodeAccount(accountId: string): Promise<ClaudeCodeAccountsResponse> {
	const { data, error } = await apiClient.POST("/api/v1/agents/claude-code/accounts/{accountId}/logout", { params: { path: { accountId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountsResponse;
}

export async function deleteClaudeCodeAccount(accountId: string): Promise<ClaudeCodeAccountsResponse> {
	const { data, error } = await apiClient.DELETE("/api/v1/agents/claude-code/accounts/{accountId}", { params: { path: { accountId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountsResponse;
}

export async function startClaudeCodeAccountSwitch(targetAccountId: string, expectedAccountRevision: number, idempotencyKey: string): Promise<ClaudeCodeAccountSwitch> {
	const { data, error } = await apiClient.POST("/api/v1/agents/claude-code/account-switches", { body: { targetAccountId, expectedAccountRevision, idempotencyKey } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountSwitch;
}

export async function recoverClaudeCodeAccountSwitch(switchId: string): Promise<ClaudeCodeAccountSwitch> {
	const { data, error } = await apiClient.POST("/api/v1/agents/claude-code/account-switches/{switchId}/recover", { params: { path: { switchId } } });
	if (error) throw new Error(apiErrorMessage(error));
	return data as ClaudeCodeAccountSwitch;
}

export const claudeCodeAccountsQueryOptions = {
	queryKey: claudeCodeAccountsQueryKey,
	queryFn: async ({ client }: { client: QueryClient }) => {
		const incoming = await fetchClaudeCodeAccounts();
		return mergeClaudeCodeAccounts(client.getQueryData<ClaudeCodeAccountsResponse>(claudeCodeAccountsQueryKey), incoming);
	},
	retry: 1,
	staleTime: Number.POSITIVE_INFINITY,
};

export function useClaudeCodeAccountsQuery(enabled = true) {
	return useQuery({ ...claudeCodeAccountsQueryOptions, enabled });
}

export function useEnsureClaudeCodeAccounts(enabled = true): void {
	const queryClient = useQueryClient();
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		const ensure = () => {
			const cached = queryClient.getQueryData(claudeCodeAccountsQueryKey);
			const ready = cached ? Promise.resolve() : queryClient.fetchQuery(claudeCodeAccountsQueryOptions).then(() => undefined).catch(() => undefined);
			void ready.then(() => ensureClaudeCodeAccounts()).then((next) => {
				if (active) writeClaudeCodeAccounts(queryClient, next);
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
