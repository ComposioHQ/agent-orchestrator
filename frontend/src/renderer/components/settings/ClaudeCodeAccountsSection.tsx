import { ArrowRightLeft, LoaderCircle, Plus, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useClaudeCodeAccountActions } from "../../hooks/useClaudeCodeAccountActions";
import { claudeCodeSwitchDisplay } from "../../hooks/claude-code-accounts-state";
import { useClaudeCodeAccountsQuery, useEnsureClaudeCodeAccounts, type ClaudeCodeAccount, type ClaudeCodeAccountSwitch, type ClaudeCodeActiveLogin } from "../../hooks/useClaudeCodeAccountsQuery";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { AgentProviderGroup } from "./AgentProviderGroup";
import { ClaudeCodeAccountLoginTerminalPanel } from "./ClaudeCodeAccountLoginTerminalPanel";
import { ClaudeCodeAccountRow } from "./ClaudeCodeAccountRow";
import { SettingsSection } from "./SettingsSection";

type PendingClaudeCodeAccountAction =
	| { kind: "switch"; account: ClaudeCodeAccount; idempotencyKey: string; submitting: boolean }
	| { kind: "logout"; account: ClaudeCodeAccount; submitting: boolean }
	| { kind: "delete"; account: ClaudeCodeAccount; submitting: boolean }
	| null;

export function ClaudeCodeAccountsSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const accountsQuery = useClaudeCodeAccountsQuery();
	useEnsureClaudeCodeAccounts(true);
	const actions = useClaudeCodeAccountActions(queryClient);
	const [providerExpanded, setProviderExpanded] = useState(true);
	const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
	const [pendingAction, setPendingAction] = useState<PendingClaudeCodeAccountAction>(null);
	const [announcement, setAnnouncement] = useState("");
	const [switchOutcome, setSwitchOutcome] = useState<{ switchId: string; succeeded: boolean } | null>(null);
	const previousSwitch = useRef<ClaudeCodeAccountSwitch | null>(null);
	const data = accountsQuery.data;
	const activeLogin = data?.activeLogin ?? null;
	const activeAccount = data?.accounts.find((account) => account.id === data.activeAccountId);
	const currentSwitch = data?.currentSwitch;
	const switchPresentation = currentSwitch ? claudeCodeSwitchDisplay(currentSwitch) : null;
	const switchStatus = switchPresentation ? t(switchPresentation.key) : null;
	const accountsError = accountsQuery.error instanceof Error ? accountsQuery.error.message : null;
	const switchBlocksMutations = Boolean(currentSwitch && currentSwitch.phase !== "completed" && currentSwitch.phase !== "failed");
	const mutationDisabled = Boolean(activeLogin || switchBlocksMutations || pendingAction?.submitting || actions.loginPending || actions.recoverPending);
	const switchSourceAvailable = Boolean(data?.activeAccountId && activeAccount && !data.unmanagedGlobalAccount);
	const switchTargets = data?.accounts.filter((account) => account.id !== data.activeAccountId) ?? [];
	const switchUnsupported = data?.capabilities.globalSwitch.state !== "supported";

	useEffect(() => {
		if (!activeLogin) return;
		setProviderExpanded(true);
		if (activeLogin.accountId) setExpandedAccount(activeLogin.accountId);
	}, [activeLogin?.accountId, activeLogin?.operationId]);

	useEffect(() => {
		if (currentSwitch) {
			previousSwitch.current = currentSwitch;
			setSwitchOutcome(null);
			return;
		}
		const observed = previousSwitch.current;
		if (!data || !observed) return;
		previousSwitch.current = null;
		setSwitchOutcome({ switchId: observed.id, succeeded: data.activeAccountId === observed.targetAccountId });
	}, [currentSwitch, data?.activeAccountId]);

	const beginLogin = useCallback(async (accountId?: string) => {
		if (activeLogin || switchBlocksMutations) return;
		setProviderExpanded(true);
		if (accountId) setExpandedAccount(accountId);
		setAnnouncement("");
		await actions.beginLogin(accountId).catch(() => undefined);
	}, [actions, activeLogin, switchBlocksMutations]);

	const verifyLogin = useCallback(async (login: ClaudeCodeActiveLogin) => {
		const operation = await actions.verifyLogin(login).catch(() => undefined);
		if (operation?.status !== "completed" || !operation.account) return;
		setAnnouncement(t("settings.claudeCodeAccounts.loginSuccess", { label: operation.account.label }));
		window.requestAnimationFrame(() => document.getElementById(`claude-code-account-${operation.account?.id}`)?.focus());
	}, [actions, t]);

	const openPending = (kind: Exclude<PendingClaudeCodeAccountAction, null>["kind"], account: ClaudeCodeAccount) => {
		if (kind === "switch") setPendingAction({ kind, account, idempotencyKey: crypto.randomUUID(), submitting: false });
		else setPendingAction({ kind, account, submitting: false });
	};

	const submitPending = useCallback(async () => {
		const pending = pendingAction;
		if (!pending || pending.submitting || !data) return;
		setPendingAction({ ...pending, submitting: true });
		try {
			switch (pending.kind) {
				case "switch": await actions.switchAccount(pending.account, data.accountRevision, pending.idempotencyKey); break;
				case "logout": await actions.logoutAccount(pending.account); setAnnouncement(t("settings.claudeCodeAccounts.logoutSuccess", { label: pending.account.label })); break;
				case "delete": await actions.deleteAccount(pending.account); if (expandedAccount === pending.account.id) setExpandedAccount(null); setAnnouncement(t("settings.claudeCodeAccounts.deleteSuccess", { label: pending.account.label })); break;
			}
			setPendingAction(null);
		} catch {
			setPendingAction({ ...pending, submitting: false });
		}
	}, [actions, data, expandedAccount, pendingAction, t]);

	const dialog = useMemo(() => {
		if (!pendingAction) return null;
		switch (pendingAction.kind) {
			case "switch": return { title: t("settings.claudeCodeAccounts.switchTitle"), description: t("settings.claudeCodeAccounts.switchDescription", { label: pendingAction.account.label }), confirmLabel: t("settings.claudeCodeAccounts.switchConfirm"), destructive: false };
			case "logout": return { title: t("settings.claudeCodeAccounts.logoutTitle"), description: t("settings.claudeCodeAccounts.logoutDescription", { label: pendingAction.account.label }), confirmLabel: t("settings.claudeCodeAccounts.logout"), destructive: false };
			case "delete": return { title: t("settings.claudeCodeAccounts.deleteTitle"), description: t("settings.claudeCodeAccounts.deleteDescription", { label: pendingAction.account.label }), confirmLabel: t("settings.claudeCodeAccounts.delete"), destructive: true };
		}
	}, [pendingAction, t]);

	const summary = accountsError ?? (data
		? activeAccount?.label ?? data.unmanagedGlobalAccount?.label ?? t("settings.claudeCodeAccounts.count", { count: data.accounts.length })
		: t("settings.claudeCodeAccounts.loading"));

	return <SettingsSection title={t("settings.codexAccounts.title")} sectionId="claude-code-accounts" titleHidden={titleHidden}>
		<AgentProviderGroup provider="claude-code" name="Claude Code" summary={summary} expanded={providerExpanded || Boolean(activeLogin)} onExpandedChange={setProviderExpanded} collapseLocked={Boolean(activeLogin)} action={<div className="flex items-center gap-2">
			{switchPresentation?.busy && switchStatus ? <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-label={switchStatus} /> : null}
			{switchSourceAvailable && switchTargets.length > 0 ? <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" disabled={mutationDisabled || switchUnsupported} title={switchUnsupported ? data?.capabilities.globalSwitch.reason : undefined}><ArrowRightLeft aria-hidden="true" />{t("settings.claudeCodeAccounts.switchConfirm")}</Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-64">{switchTargets.map((account) => { const authorized = account.authentication.state === "authorized" || account.authentication.state === "not_applicable"; return <DropdownMenuItem key={account.id} disabled={account.status !== "valid" || !authorized} onSelect={() => openPending("switch", account)}><UserRound aria-hidden="true" /><div className="min-w-0"><p className="truncate text-foreground">{account.label}</p><p className="truncate text-micro text-muted-foreground">{account.identity.organizationName ?? account.identity.seatTier ?? account.status}</p></div></DropdownMenuItem>; })}</DropdownMenuContent></DropdownMenu> : null}
			<Button type="button" size="sm" title={data?.capabilities.nativeLogin.state === "supported" ? undefined : data?.capabilities.nativeLogin.reason} onClick={() => void beginLogin()} disabled={mutationDisabled || data?.capabilities.nativeLogin.state !== "supported"}><Plus aria-hidden="true" />{t("settings.claudeCodeAccounts.add")}</Button>
		</div>}>
			{actions.error ? <p role="alert" className="border-b border-border px-4 py-3 text-xs text-error">{actions.error}</p> : null}
			{data?.unmanagedGlobalAccount ? <div className="border-b border-border px-4 py-3 text-xs"><p className="font-medium text-foreground">{data.unmanagedGlobalAccount.label}</p><p className="mt-1 text-muted-foreground">{data.unmanagedGlobalAccount.reason}</p></div> : null}
			<p className="border-b border-border px-4 py-3 text-xs text-muted-foreground">{t("settings.claudeCodeAccounts.deviceScope")}</p>
			{announcement ? <p className="sr-only" role="status" aria-live="polite">{announcement}</p> : null}
			{switchOutcome ? <p key={switchOutcome.switchId} className={`border-b border-border px-4 py-3 text-xs ${switchOutcome.succeeded ? "text-muted-foreground" : "text-error"}`} role="status" aria-live="polite">{t(switchOutcome.succeeded ? "settings.claudeCodeAccounts.propagationNotice" : "settings.claudeCodeAccounts.switch.failed")}</p> : null}
			{currentSwitch && switchStatus ? <p className={`border-b border-border px-4 py-3 text-xs ${switchPresentation?.tone === "error" ? "text-error" : switchPresentation?.tone === "warning" ? "text-warning" : "text-muted-foreground"}`} role="status" aria-live="polite">{switchStatus}</p> : null}
			{activeLogin && !activeLogin.accountId ? <div className="border-b border-border px-4 py-3" data-testid="claude-code-account-pending-row"><ClaudeCodeAccountLoginTerminalPanel activeLogin={activeLogin} pending={actions.loginOperationPending} onCheckAgain={() => void verifyLogin(activeLogin)} onClose={() => void actions.closeLogin(activeLogin)} onRetry={() => void actions.retryLogin(activeLogin)} /></div> : null}
			{accountsQuery.isLoading ? <p className="px-4 py-3 text-xs text-muted-foreground">{t("settings.claudeCodeAccounts.loading")}</p> : null}{accountsError ? <p className="px-4 py-3 text-xs text-error" role="alert">{accountsError}</p> : null}
			<div className="divide-y divide-border">{data?.accounts.map((account) => <ClaudeCodeAccountRow key={account.id} account={account} expanded={expandedAccount === account.id} mutationDisabled={mutationDisabled} logoutBusy={pendingAction?.kind === "logout" && pendingAction.account.id === account.id && pendingAction.submitting} deleteBusy={pendingAction?.kind === "delete" && pendingAction.account.id === account.id && pendingAction.submitting} activeLogin={activeLogin?.accountId === account.id ? activeLogin : null} loginPending={actions.loginOperationPending} onToggle={() => setExpandedAccount(expandedAccount === account.id ? null : account.id)} onSignIn={() => void beginLogin(account.id)} onLogout={() => openPending("logout", account)} onDelete={() => openPending("delete", account)} onCheckLogin={() => activeLogin && void verifyLogin(activeLogin)} onCloseLogin={() => activeLogin && void actions.closeLogin(activeLogin)} onRetryLogin={() => activeLogin && void actions.retryLogin(activeLogin)} />)}</div>
			{switchPresentation?.canRecover && currentSwitch ? <div className="border-t border-border px-4 py-3"><Button type="button" size="sm" variant="outline" disabled={actions.recoverPending} onClick={() => void actions.recoverSwitch(currentSwitch.id)}>{actions.recoverPending ? <LoaderCircle className="animate-spin" aria-label={t("settings.claudeCodeAccounts.recovering")} /> : null}{t("settings.claudeCodeAccounts.recover")}</Button></div> : null}
		</AgentProviderGroup>
		{dialog && pendingAction ? <ConfirmDialog open title={dialog.title} description={dialog.description} confirmLabel={dialog.confirmLabel} destructive={dialog.destructive} busy={pendingAction.submitting} error={actions.error} onConfirm={() => void submitPending()} onOpenChange={(open) => { if (!open && !pendingAction.submitting) setPendingAction(null); }} /> : null}
	</SettingsSection>;
}
