import { CircleAlert, CircleCheck, LoaderCircle, Plus, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
	cacheCodexProfile,
	createCodexProfile,
	ensureCodexProfiles,
	mergeCodexProfiles,
	openCodexProfileLoginTerminal,
	useCodexProfilesQuery,
	useEnsureCodexProfiles,
	type CodexProfile,
} from "../../hooks/useCodexProfilesQuery";
import { closeShellTerminal, shellTerminalsQueryKey } from "../../hooks/useShellTerminals";
import type { TerminalSessionState } from "../../hooks/useTerminalSession";
import { useShellMaybe } from "../../lib/shell-context";
import {
	type CodexProfileLoginTerminalWorkflow,
	useResolvedTheme,
	useUiStore,
} from "../../stores/ui-store";
import { TerminalPane } from "../TerminalPane";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./SettingsSection";

const loginTerminalLifetimeMs = 15 * 60_000;

export function CodexProfilesSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const profilesQuery = useCodexProfilesQuery();
	useEnsureCodexProfiles(true);
	const [adding, setAdding] = useState(false);
	const [label, setLabel] = useState("");
	const [busyProfile, setBusyProfile] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const loginWorkflow = useUiStore((state) => state.codexProfileLoginTerminal);
	const startLoginTerminal = useUiStore((state) => state.startCodexProfileLoginTerminal);
	const updateLoginTerminal = useUiStore((state) => state.updateCodexProfileLoginTerminal);
	const clearLoginTerminal = useUiStore((state) => state.clearCodexProfileLoginTerminal);

	const beginLogin = useCallback(async (profileId: string) => {
		if (useUiStore.getState().codexProfileLoginTerminal) return;
		setBusyProfile(profileId);
		setError(null);
		setAnnouncement("");
		try {
			const started = await openCodexProfileLoginTerminal(profileId);
			startLoginTerminal(started.profileId, {
				handleId: started.shellTerminal.handleId,
				title: started.shellTerminal.title,
				createdAt: started.shellTerminal.createdAt,
			});
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("settings.codexProfiles.loginFailed"));
		} finally {
			setBusyProfile(null);
		}
	}, [queryClient, startLoginTerminal, t]);

	const verifyLogin = useCallback(async (workflow: CodexProfileLoginTerminalWorkflow) => {
		const { handleId } = workflow.terminal;
		const current = useUiStore.getState().codexProfileLoginTerminal;
		if (!current || current.terminal.handleId !== handleId || current.phase === "verifying") return;
		updateLoginTerminal(handleId, { phase: "verifying", reason: undefined });
		try {
			const next = await ensureCodexProfiles([workflow.profileId], true);
			if (useUiStore.getState().codexProfileLoginTerminal?.terminal.handleId !== handleId) return;
			mergeCodexProfiles(queryClient, next);
			const profile = next.profiles.find((item) => item.id === workflow.profileId);
			const verified = profile?.authentication.freshness === "fresh" &&
				(profile.authentication.state === "authorized" || profile.authentication.state === "not_applicable");
			if (verified) {
				// Authentication is authoritative. Cleanup is best-effort here because
				// the PTY has already ended and list reconciliation will prune it.
				void closeShellTerminal(handleId).catch(() => undefined).finally(() => {
					void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
				});
				clearLoginTerminal(handleId);
				setAnnouncement(t("settings.codexProfiles.loginSuccess", { label: profile.label }));
				window.requestAnimationFrame(() => {
					document.getElementById(`codex-profile-${workflow.profileId}`)?.focus();
				});
				return;
			}
			const unauthorized = profile?.authentication.freshness === "fresh" &&
				profile.authentication.state === "unauthorized";
			updateLoginTerminal(handleId, {
				phase: unauthorized ? "unauthorized" : "unverified",
				reason: unauthorized
					? t("settings.codexProfiles.loginUnauthorized")
					: t("settings.codexProfiles.loginUnverified"),
			});
		} catch {
			updateLoginTerminal(handleId, {
				phase: "unverified",
				reason: t("settings.codexProfiles.loginVerificationFailed"),
			});
		}
	}, [clearLoginTerminal, queryClient, t, updateLoginTerminal]);

	const closeInlineLogin = useCallback(async (workflow: CodexProfileLoginTerminalWorkflow) => {
		const { handleId } = workflow.terminal;
		updateLoginTerminal(handleId, { phase: "closing", reason: undefined });
		try {
			await closeShellTerminal(handleId);
			clearLoginTerminal(handleId);
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
		} catch {
			updateLoginTerminal(handleId, {
				phase: workflow.phase,
				reason: t("settings.codexProfiles.loginCloseFailed"),
			});
		}
	}, [clearLoginTerminal, queryClient, t, updateLoginTerminal]);

	const retryLogin = useCallback(async (workflow: CodexProfileLoginTerminalWorkflow) => {
		const { handleId } = workflow.terminal;
		updateLoginTerminal(handleId, { phase: "closing", reason: undefined });
		try {
			await closeShellTerminal(handleId);
			clearLoginTerminal(handleId);
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
			await beginLogin(workflow.profileId);
		} catch {
			updateLoginTerminal(handleId, {
				phase: workflow.phase,
				reason: t("settings.codexProfiles.loginCloseFailed"),
			});
		}
	}, [beginLogin, clearLoginTerminal, queryClient, t, updateLoginTerminal]);

	useEffect(() => {
		if (!loginWorkflow || loginWorkflow.phase !== "running") return;
		const { handleId } = loginWorkflow.terminal;
		const remaining = Math.max(0, loginTerminalLifetimeMs - (Date.now() - loginWorkflow.startedAt));
		const timeout = window.setTimeout(() => {
			if (useUiStore.getState().codexProfileLoginTerminal?.terminal.handleId !== handleId) return;
			updateLoginTerminal(handleId, { phase: "closing", reason: undefined });
			void closeShellTerminal(handleId).then(() => {
				updateLoginTerminal(handleId, {
					phase: "timed_out",
					reason: t("settings.codexProfiles.loginTimedOut"),
				});
				void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
			}).catch(() => {
				updateLoginTerminal(handleId, {
					phase: "timed_out",
					reason: t("settings.codexProfiles.loginCloseFailed"),
				});
			});
		}, remaining);
		return () => window.clearTimeout(timeout);
	}, [loginWorkflow, queryClient, t, updateLoginTerminal]);

	const createProfile = async () => {
		const nextLabel = label.trim();
		if (!nextLabel || loginWorkflow) return;
		setBusyProfile("create");
		setError(null);
		try {
			const profile = await createCodexProfile(nextLabel);
			// The durable profile is visible even if opening its login terminal fails.
			cacheCodexProfile(queryClient, profile);
			setLabel("");
			setAdding(false);
			await beginLogin(profile.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("settings.codexProfiles.createFailed"));
		} finally {
			setBusyProfile(null);
		}
	};

	return (
		<SettingsSection title={t("settings.codexProfiles.title")} sectionId="codex-profiles" titleHidden={titleHidden}>
			<div className="flex flex-col gap-3 rounded-md bg-[var(--color-bg-settings-row)] p-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="text-sm font-medium text-foreground">{t("settings.codexProfiles.heading")}</p>
					</div>
					<Button type="button" size="sm" onClick={() => setAdding(true)} disabled={adding || Boolean(loginWorkflow) || !profilesQuery.data}>
						<Plus aria-hidden="true" /> {t("settings.codexProfiles.add")}
					</Button>
				</div>

				{adding ? (
					<div className="flex items-center gap-2">
						<Input aria-label={t("settings.codexProfiles.label")} value={label} maxLength={80} autoFocus onChange={(event) => setLabel(event.target.value)} placeholder={t("settings.codexProfiles.labelPlaceholder")} />
						<Button type="button" size="sm" onClick={() => void createProfile()} disabled={!label.trim() || busyProfile === "create" || Boolean(loginWorkflow)}>{t("settings.codexProfiles.create")}</Button>
						<Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); setLabel(""); }}>{t("settings.codexProfiles.cancel")}</Button>
					</div>
				) : null}

				{error ? <p role="alert" className="text-xs text-error">{error}</p> : null}
				{announcement ? <p className="sr-only" role="status" aria-live="polite">{announcement}</p> : null}
				{profilesQuery.isLoading ? <p className="text-xs text-muted-foreground">{t("settings.codexProfiles.loading")}</p> : null}
				{profilesQuery.data?.profiles.map((profile) => (
					<CodexProfileRow
						key={profile.id}
						profile={profile}
						busy={busyProfile === profile.id}
						loginWorkflow={loginWorkflow?.profileId === profile.id ? loginWorkflow : null}
						loginActive={Boolean(loginWorkflow)}
						onCheckAgain={verifyLogin}
						onCloseLogin={closeInlineLogin}
						onLogin={() => void beginLogin(profile.id)}
						onRetry={retryLogin}
						onTerminalState={(state) => {
							if ((state !== "exited" && state !== "error") || !loginWorkflow) return;
							const current = useUiStore.getState().codexProfileLoginTerminal;
							if (current?.terminal.handleId === loginWorkflow.terminal.handleId && current.phase === "running") {
								void verifyLogin(current);
							}
						}}
					/>
				))}
			</div>
		</SettingsSection>
	);
}

function CodexProfileRow({ profile, busy, loginWorkflow, loginActive, onCheckAgain, onCloseLogin, onLogin, onRetry, onTerminalState }: {
	profile: CodexProfile;
	busy: boolean;
	loginWorkflow: CodexProfileLoginTerminalWorkflow | null;
	loginActive: boolean;
	onCheckAgain: (workflow: CodexProfileLoginTerminalWorkflow) => Promise<void>;
	onCloseLogin: (workflow: CodexProfileLoginTerminalWorkflow) => Promise<void>;
	onLogin: () => void;
	onRetry: (workflow: CodexProfileLoginTerminalWorkflow) => Promise<void>;
	onTerminalState: (state: TerminalSessionState) => void;
}) {
	const { t } = useTranslation();
	const auth = profile.authentication;
	const checking = auth.freshness === "checking";
	const authLabel = auth.state === "authorized"
		? t("settings.codexProfiles.signedIn")
		: auth.state === "unauthorized"
			? t("settings.codexProfiles.signedOut")
			: auth.state === "not_applicable"
				? t("settings.codexProfiles.notRequired")
				: t("settings.codexProfiles.unknown");
	const canLogin = profile.status === "valid" && auth.state !== "authorized" && auth.state !== "not_applicable";

	return (
		<div
			className="rounded-md border border-border bg-background/40 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
			data-profile-id={profile.id}
			id={`codex-profile-${profile.id}`}
			tabIndex={-1}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 gap-3">
					<div data-testid="codex-profile-avatar" className="grid size-9 shrink-0 self-center place-items-center rounded-full border border-border bg-muted"><UserRound className="size-4" aria-hidden="true" /></div>
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<p className="truncate text-sm font-medium">{profile.label}</p>
							{profile.id === "existing" ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("settings.codexProfiles.existing")}</span> : null}
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">{profile.usableByCurrentLaunches ? t("settings.codexProfiles.usedBySessions") : t("settings.codexProfiles.notLaunchable")}</p>
						{profile.status === "broken" ? <>
							<p className="mt-1 text-xs text-error">{profile.reason}</p>
							<p className="mt-1 text-xs text-muted-foreground">{t("settings.codexProfiles.recovery")}</p>
						</> : (
							<p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
								{auth.state === "authorized" ? <CircleCheck className="size-3.5 text-success" aria-hidden="true" /> : <CircleAlert className="size-3.5" aria-hidden="true" />}
								{authLabel}{profile.accountEmail ? ` · ${profile.accountEmail}` : ""}{profile.authMethod !== "unknown" ? ` · ${profile.authMethod}` : ""}
								{checking ? <LoaderCircle className="ml-1 size-3.5 animate-spin" aria-label={t("settings.codexProfiles.checking")} /> : null}
							</p>
						)}
						{profile.status === "valid" && auth.freshness === "stale" && auth.reason ? <p className="mt-1 text-xs text-muted-foreground">{auth.reason}</p> : null}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{canLogin && !loginWorkflow ? (
						<Button type="button" size="sm" variant="outline" onClick={onLogin} disabled={busy || loginActive}>{t("settings.codexProfiles.signIn")}</Button>
					) : null}
				</div>
			</div>
			{loginWorkflow ? (
				<CodexProfileLoginTerminalPanel
					workflow={loginWorkflow}
					onCheckAgain={() => void onCheckAgain(loginWorkflow)}
					onClose={() => void onCloseLogin(loginWorkflow)}
					onRetry={() => void onRetry(loginWorkflow)}
					onTerminalState={onTerminalState}
				/>
			) : null}
		</div>
	);
}

function CodexProfileLoginTerminalPanel({ workflow, onCheckAgain, onClose, onRetry, onTerminalState }: {
	workflow: CodexProfileLoginTerminalWorkflow;
	onCheckAgain: () => void;
	onClose: () => void;
	onRetry: () => void;
	onTerminalState: (state: TerminalSessionState) => void;
}) {
	const { t } = useTranslation();
	const theme = useResolvedTheme();
	const shell = useShellMaybe();
	const daemonReady = shell ? shell.daemonStatus.state === "ready" : true;
	const panelRef = useRef<HTMLDivElement>(null);
	const terminalStateHandlerRef = useRef(onTerminalState);
	terminalStateHandlerRef.current = onTerminalState;
	const handleTerminalState = useCallback((state: TerminalSessionState) => {
		terminalStateHandlerRef.current(state);
	}, []);
	useEffect(() => {
		panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, [workflow.terminal.handleId]);
	const status = workflow.phase === "running"
		? t("settings.codexProfiles.loginRunning")
		: workflow.phase === "verifying"
			? t("settings.codexProfiles.loginVerifying")
			: workflow.phase === "closing"
				? t("settings.codexProfiles.loginClosing")
				: (workflow.reason ?? t("settings.codexProfiles.loginUnverified"));
	const retryable = workflow.phase === "unauthorized" || workflow.phase === "timed_out";
	const checkable = workflow.phase === "unverified";

	return (
		<div ref={panelRef} className="mt-3 scroll-my-3 overflow-hidden rounded-md border border-border bg-terminal" data-testid="codex-profile-login-terminal">
			<div className="flex min-h-10 items-center justify-between gap-3 border-b border-border bg-surface/90 px-3 py-2">
				<div className="min-w-0">
					<p className="truncate text-xs font-medium text-foreground">{t("settings.codexProfiles.loginTerminalTitle")}</p>
					<p className="truncate text-[11px] text-muted-foreground" aria-live="polite" role="status">{status}</p>
				</div>
				<button
					type="button"
					aria-label={t("settings.codexProfiles.loginClose")}
					className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
					disabled={workflow.phase === "closing"}
					onClick={onClose}
				>
					<X className="size-4" aria-hidden="true" />
				</button>
			</div>
			<div className="h-[300px] min-h-0">
				<TerminalPane
					daemonReady={daemonReady}
					fontSize={12}
					onTerminalStateChange={handleTerminalState}
					terminalTarget={{
						kind: "shell",
						handleId: workflow.terminal.handleId,
						generation: workflow.terminal.createdAt,
						title: workflow.terminal.title,
					}}
					theme={theme}
				/>
			</div>
			{workflow.reason || retryable || checkable ? (
				<div className="flex items-center justify-between gap-3 border-t border-border bg-surface/90 px-3 py-2">
					<p className="min-w-0 text-xs text-muted-foreground" role={workflow.reason ? "alert" : undefined}>{workflow.reason}</p>
					<div className="flex shrink-0 items-center gap-2">
						{retryable ? <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t("settings.codexProfiles.retry")}</Button> : null}
						{checkable ? <Button type="button" size="sm" variant="outline" onClick={onCheckAgain}>{t("settings.codexProfiles.loginCheckAgain")}</Button> : null}
						<Button type="button" size="sm" variant="ghost" onClick={onClose}>{t("settings.codexProfiles.loginClose")}</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}
