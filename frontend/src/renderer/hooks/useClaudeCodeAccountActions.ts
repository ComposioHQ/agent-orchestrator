import { useCallback, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { shellTerminalsQueryKey } from "./useShellTerminals";
import {
	cancelClaudeCodeAccountLogin,
	activateClaudeCodeAccount,
	deleteClaudeCodeAccount,
	ensureClaudeCodeAccounts,
	logoutClaudeCodeAccount,
	openClaudeCodeAccountLoginTerminal,
	openClaudeCodeAccountReauthenticationTerminal,
	recoverClaudeCodeAccountSwitch,
	startClaudeCodeAccountSwitch,
	verifyClaudeCodeAccountLogin,
	type ClaudeCodeAccount,
	type ClaudeCodeActiveLogin,
	type ClaudeCodeAccountsResponse,
} from "./useClaudeCodeAccountsQuery";
import { claudeCodeAccountsQueryKey, writeClaudeCodeAccounts } from "./claude-code-accounts-state";

export function useClaudeCodeAccountActions(queryClient: QueryClient) {
	const { t } = useTranslation();
	const [error, setError] = useState<string | null>(null);
	const [loginPending, setLoginPending] = useState(false);
	const [loginOperationPending, setLoginOperationPending] = useState(false);
	const [recoverPending, setRecoverPending] = useState(false);
	const verifyingRef = useRef<string | null>(null);

	const current = useCallback(() => queryClient.getQueryData<ClaudeCodeAccountsResponse>(claudeCodeAccountsQueryKey), [queryClient]);
	const writeCurrent = useCallback((update: (snapshot: ClaudeCodeAccountsResponse) => ClaudeCodeAccountsResponse) => {
		const snapshot = current();
		if (snapshot) writeClaudeCodeAccounts(queryClient, update(snapshot));
	}, [current, queryClient]);

	const beginLogin = useCallback(async (accountId?: string) => {
		setError(null);
		setLoginPending(true);
		try {
			await queryClient.cancelQueries({ queryKey: claudeCodeAccountsQueryKey });
			const started = accountId
				? await openClaudeCodeAccountReauthenticationTerminal(accountId)
				: await openClaudeCodeAccountLoginTerminal();
			writeCurrent((snapshot) => ({
				...snapshot,
				activeLogin: {
					operationId: started.operation.operationId,
					accountId: started.operation.accountId ?? accountId,
					status: started.operation.status,
					reasonCode: started.operation.reasonCode,
					reason: started.operation.reason,
					expiresAt: started.operation.expiresAt,
					shellTerminal: started.shellTerminal,
				},
			}));
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		} catch (cause) {
			setError(t("settings.claudeCodeAccounts.loginFailed"));
			throw cause;
		} finally {
			setLoginPending(false);
		}
	}, [queryClient, t, writeCurrent]);

	const verifyLogin = useCallback(async (login: ClaudeCodeActiveLogin) => {
		const key = `${login.operationId}:${login.shellTerminal.handleId}`;
		if (verifyingRef.current === key) return;
		verifyingRef.current = key;
		setError(null);
		setLoginOperationPending(true);
		try {
			const operation = await verifyClaudeCodeAccountLogin(login.operationId);
			writeCurrent((snapshot) => {
				const accounts = operation.account
					? [...snapshot.accounts.filter((account) => account.id !== operation.account?.id), operation.account]
					: snapshot.accounts;
				return {
					...snapshot,
					accounts,
					activeLogin: operation.status === "completed" ? undefined : {
						...login,
						accountId: operation.accountId ?? login.accountId,
						status: operation.status,
						reasonCode: operation.reasonCode,
						reason: operation.reason,
						expiresAt: operation.expiresAt,
					},
				};
			});
			if (operation.status === "completed") {
				void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
				if (operation.account?.active) {
					try { writeClaudeCodeAccounts(queryClient, await ensureClaudeCodeAccounts()); }
					catch { void queryClient.invalidateQueries({ queryKey: claudeCodeAccountsQueryKey }); }
				}
			}
			return operation;
		} catch (cause) {
			setError(t("settings.claudeCodeAccounts.loginVerificationFailed"));
			throw cause;
		} finally {
			verifyingRef.current = null;
			setLoginOperationPending(false);
		}
	}, [queryClient, t, writeCurrent]);

	const activateAccount = useCallback(async (account: ClaudeCodeAccount) => {
		setError(null);
		try { writeClaudeCodeAccounts(queryClient, await activateClaudeCodeAccount(account.id)); }
		catch (cause) { setError(t("settings.claudeCodeAccounts.switchFailed")); throw cause; }
	}, [queryClient, t]);

	const closeLogin = useCallback(async (login: ClaudeCodeActiveLogin) => {
		setError(null);
		setLoginOperationPending(true);
		try {
			const operation = await cancelClaudeCodeAccountLogin(login.operationId);
			writeCurrent((snapshot) => ({ ...snapshot, activeLogin: operation.status === "cancelled" ? undefined : { ...login, ...operation } }));
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		} catch (cause) {
			setError(t("settings.claudeCodeAccounts.loginCloseFailed"));
			throw cause;
		} finally {
			setLoginOperationPending(false);
		}
	}, [queryClient, t, writeCurrent]);

	const retryLogin = useCallback(async (login: ClaudeCodeActiveLogin) => {
		await closeLogin(login);
		await beginLogin(login.accountId);
	}, [beginLogin, closeLogin]);

	const switchAccount = useCallback(async (account: ClaudeCodeAccount, revision: number, idempotencyKey: string) => {
		setError(null);
		try {
			await queryClient.cancelQueries({ queryKey: claudeCodeAccountsQueryKey });
			const nextSwitch = await startClaudeCodeAccountSwitch(account.id, revision, idempotencyKey);
			writeCurrent((snapshot) => ({ ...snapshot, currentSwitch: nextSwitch }));
		} catch (cause) {
			setError(t("settings.claudeCodeAccounts.switchFailed"));
			throw cause;
		}
	}, [queryClient, t, writeCurrent]);

	const recoverSwitch = useCallback(async (switchId: string) => {
		setError(null);
		setRecoverPending(true);
		try {
			const nextSwitch = await recoverClaudeCodeAccountSwitch(switchId);
			writeCurrent((snapshot) => ({ ...snapshot, currentSwitch: nextSwitch }));
		} catch (cause) {
			setError(t("settings.claudeCodeAccounts.switchRecoveryFailed"));
			throw cause;
		} finally {
			setRecoverPending(false);
		}
	}, [t, writeCurrent]);

	const logoutAccount = useCallback(async (account: ClaudeCodeAccount) => {
		setError(null);
		try { writeClaudeCodeAccounts(queryClient, await logoutClaudeCodeAccount(account.id)); }
		catch (cause) { setError(t("settings.claudeCodeAccounts.logoutFailed")); throw cause; }
	}, [queryClient, t]);

	const deleteAccount = useCallback(async (account: ClaudeCodeAccount) => {
		setError(null);
		try { writeClaudeCodeAccounts(queryClient, await deleteClaudeCodeAccount(account.id)); }
		catch (cause) { setError(t("settings.claudeCodeAccounts.deleteFailed")); throw cause; }
	}, [queryClient, t]);

	return {
		error, loginPending, loginOperationPending, recoverPending,
		beginLogin, verifyLogin, closeLogin, retryLogin,
		activateAccount, switchAccount, recoverSwitch, logoutAccount, deleteAccount,
	};
}
