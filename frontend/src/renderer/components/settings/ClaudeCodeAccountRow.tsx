import { ChevronDown, CircleAlert, CircleCheck, LoaderCircle, LogOut, Trash2, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ClaudeCodeAccount, ClaudeCodeActiveLogin } from "../../hooks/useClaudeCodeAccountsQuery";
import { Button } from "../ui/button";
import { ClaudeCodeAccountLoginTerminalPanel } from "./ClaudeCodeAccountLoginTerminalPanel";

export function ClaudeCodeAccountRow({ account, expanded, mutationDisabled, logoutBusy, deleteBusy, activeLogin, loginPending, onToggle, onSignIn, onLogout, onDelete, onCheckLogin, onCloseLogin, onRetryLogin }: {
	account: ClaudeCodeAccount;
	expanded: boolean;
	mutationDisabled: boolean;
	logoutBusy: boolean;
	deleteBusy: boolean;
	activeLogin: ClaudeCodeActiveLogin | null;
	loginPending: boolean;
	onToggle: () => void;
	onSignIn: () => void;
	onLogout: () => void;
	onDelete: () => void;
	onCheckLogin: () => void;
	onCloseLogin: () => void;
	onRetryLogin: () => void;
}) {
	const { t } = useTranslation();
	const authorized = account.authentication.state === "authorized" || account.authentication.state === "not_applicable";
	const authenticationLabel = authorized
		? account.accountEmail && account.accountEmail !== account.label ? account.accountEmail : t("settings.claudeCodeAccounts.signedIn")
		: account.authentication.state === "unauthorized" || account.status === "signed_out" ? t("settings.claudeCodeAccounts.signedOut") : t("settings.claudeCodeAccounts.unknown");
	const identitySummary = [account.identity.organizationName, account.identity.seatTier, account.identity.billingType].filter(Boolean).join(" · ");
	return <div id={`claude-code-account-${account.id}`} data-account-id={account.id} tabIndex={-1} className="px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
		<div className="flex items-start justify-between gap-3"><button type="button" className="flex min-w-0 flex-1 items-start gap-3 rounded-sm text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded} onClick={onToggle}><UserRound className="mt-0.5 size-6 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-medium">{account.label}</p>{account.active ? <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">{t("settings.claudeCodeAccounts.inUse")}</span> : null}</div><p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">{authorized ? <CircleCheck className="size-3.5 text-success" aria-hidden="true" /> : <CircleAlert className="size-3.5" aria-hidden="true" />}{authenticationLabel}{account.authentication.freshness === "checking" ? <LoaderCircle className="size-3.5 animate-spin" aria-label={t("settings.claudeCodeAccounts.checking")} /> : null}</p>{identitySummary ? <p className="mt-1 truncate text-xs text-muted-foreground">{identitySummary}</p> : null}</div><ChevronDown className={`ml-auto mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} aria-hidden="true" /></button></div>
		{expanded ? <><div className="ml-9 mt-3 grid gap-1 text-xs text-muted-foreground">{account.identity.displayName ? <p>{account.identity.displayName}</p> : null}{account.identity.emailAddress && account.identity.emailAddress !== account.label ? <p>{account.identity.emailAddress}</p> : null}</div><div className="ml-9 mt-4 flex items-center gap-2 pb-1">{authorized ? <><Button type="button" size="sm" variant="outline" disabled={mutationDisabled || logoutBusy} onClick={onLogout}>{logoutBusy ? <LoaderCircle className="animate-spin" aria-label={t("settings.claudeCodeAccounts.loggingOut")} /> : <LogOut aria-hidden="true" />}{t("settings.claudeCodeAccounts.logout")}</Button>{!account.active ? <Button type="button" size="sm" variant="outline" className="text-error hover:text-error" disabled={mutationDisabled || deleteBusy} onClick={onDelete}>{deleteBusy ? <LoaderCircle className="animate-spin" aria-label={t("settings.claudeCodeAccounts.deleting")} /> : <Trash2 aria-hidden="true" />}{t("settings.claudeCodeAccounts.delete")}</Button> : null}</> : account.status !== "broken" ? <><Button type="button" size="sm" variant="outline" disabled={mutationDisabled} onClick={onSignIn}>{t("settings.claudeCodeAccounts.signInAgain")}</Button>{!account.active ? <Button type="button" size="sm" variant="outline" className="text-error hover:text-error" disabled={mutationDisabled || deleteBusy} onClick={onDelete}>{deleteBusy ? <LoaderCircle className="animate-spin" aria-label={t("settings.claudeCodeAccounts.deleting")} /> : <Trash2 aria-hidden="true" />}{t("settings.claudeCodeAccounts.delete")}</Button> : null}</> : null}</div>{activeLogin ? <div className="ml-9 mt-4 pb-1"><ClaudeCodeAccountLoginTerminalPanel activeLogin={activeLogin} pending={loginPending} onCheckAgain={onCheckLogin} onClose={onCloseLogin} onRetry={onRetryLogin} /></div> : null}</> : null}
	</div>;
}
