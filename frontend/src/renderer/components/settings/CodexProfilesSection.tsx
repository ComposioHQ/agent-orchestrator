import { ChevronDown, CircleAlert, CircleCheck, LoaderCircle, Plus, UserRound, X } from "lucide-react";
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
import { codexCapacityRemainingPercent } from "../../lib/codex-capacity";
import { useShellMaybe } from "../../lib/shell-context";
import {
	type CodexProfileLoginTerminalWorkflow,
	useResolvedTheme,
	useUiStore,
} from "../../stores/ui-store";
import { TerminalPane } from "../TerminalPane";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AgentProviderGroup } from "./AgentProviderGroup";
import { SettingsSection } from "./SettingsSection";

const loginTerminalLifetimeMs = 15 * 60_000;

export function CodexProfilesSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const profilesQuery = useCodexProfilesQuery();
	useEnsureCodexProfiles(true);
	const [providerExpanded, setProviderExpanded] = useState(true);
	const [adding, setAdding] = useState(false);
	const [label, setLabel] = useState("");
	const [busyProfile, setBusyProfile] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const loginWorkflow = useUiStore((state) => state.codexProfileLoginTerminal);
	const startLoginTerminal = useUiStore((state) => state.startCodexProfileLoginTerminal);
	const updateLoginTerminal = useUiStore((state) => state.updateCodexProfileLoginTerminal);
	const clearLoginTerminal = useUiStore((state) => state.clearCodexProfileLoginTerminal);
	const profileCount = profilesQuery.data?.profiles.length;

	const beginLogin = useCallback(async (profileId: string) => {
		if (useUiStore.getState().codexProfileLoginTerminal) return;
		setProviderExpanded(true);
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
			<AgentProviderGroup
				provider="codex"
				name="Codex"
				summary={profileCount === undefined
					? t("settings.codexProfiles.loading")
					: t("settings.codexProfiles.count", { count: profileCount })}
				expanded={providerExpanded || Boolean(loginWorkflow)}
				onExpandedChange={setProviderExpanded}
				collapseLocked={Boolean(loginWorkflow)}
				action={(
					<Button type="button" size="sm" onClick={() => { setProviderExpanded(true); setAdding(true); }} disabled={adding || Boolean(loginWorkflow) || !profilesQuery.data}>
						<Plus aria-hidden="true" /> {t("settings.codexProfiles.add")}
					</Button>
				)}
			>
				{adding ? (
					<div className="flex items-center gap-2 border-b border-border px-4 py-3">
						<Input aria-label={t("settings.codexProfiles.label")} value={label} maxLength={80} autoFocus onChange={(event) => setLabel(event.target.value)} placeholder={t("settings.codexProfiles.labelPlaceholder")} />
						<Button type="button" size="sm" onClick={() => void createProfile()} disabled={!label.trim() || busyProfile === "create" || Boolean(loginWorkflow)}>{t("settings.codexProfiles.create")}</Button>
						<Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); setLabel(""); }}>{t("settings.codexProfiles.cancel")}</Button>
					</div>
				) : null}

				{error ? <p role="alert" className="border-b border-border px-4 py-3 text-xs text-error">{error}</p> : null}
				{announcement ? <p className="sr-only" role="status" aria-live="polite">{announcement}</p> : null}
				{profilesQuery.isLoading ? <p className="px-4 py-3 text-xs text-muted-foreground">{t("settings.codexProfiles.loading")}</p> : null}
				<div className="divide-y divide-border">
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
			</AgentProviderGroup>
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
	const sourceLabel = profile.source === "existing"
		? t("settings.codexProfiles.existing")
		: t("settings.codexProfiles.managed");
	const authLabel = auth.state === "authorized"
		? t("settings.codexProfiles.signedIn")
		: auth.state === "unauthorized"
			? t("settings.codexProfiles.signedOut")
			: auth.state === "not_applicable"
				? t("settings.codexProfiles.notRequired")
				: t("settings.codexProfiles.unknown");
	const canLogin = profile.status === "valid" && auth.state !== "authorized" && auth.state !== "not_applicable";
	const capacity = profile.capacity;
	const capacityLabel = capacity.state === "available"
		? t("settings.codexProfiles.capacityAvailable")
		: capacity.state === "near_limit"
			? t("settings.codexProfiles.capacityNearLimit")
			: capacity.state === "exhausted"
				? t("settings.codexProfiles.capacityExhausted")
				: capacity.state === "unsupported"
					? t("settings.codexProfiles.capacityUnsupported")
					: t("settings.codexProfiles.capacityUnknown");

	return (
		<div
			className="bg-background/20 px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
			data-profile-id={profile.id}
			id={`codex-profile-${profile.id}`}
			tabIndex={-1}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-1 gap-3">
					<UserRound data-testid="codex-profile-icon" className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<p className="truncate text-sm font-medium">{profile.label}</p>
							<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{sourceLabel}</span>
						</div>
						<p className="mt-0.5 text-xs text-muted-foreground">{profile.usableByCurrentLaunches ? t("settings.codexProfiles.availableForLaunches") : t("settings.codexProfiles.notLaunchable")}</p>
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
						{profile.status === "valid" ? (
							<CodexCapacityDetails capacity={capacity} capacityLabel={capacityLabel} />
						) : null}
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

type CodexCapacity = CodexProfile["capacity"];
type CodexCapacityBucket = NonNullable<CodexCapacity["overall"]>;
type CodexCapacityWindow = NonNullable<CodexCapacityBucket["primary"]>;

function CodexCapacityDetails({ capacity, capacityLabel }: { capacity: CodexCapacity; capacityLabel: string }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const groups = [
		...(capacity.overall ? [{ id: capacity.overall.limitId, title: t("settings.codexProfiles.generalUsageLimits"), bucket: capacity.overall }] : []),
		...capacity.additionalBuckets.map((bucket) => ({
			id: bucket.limitId,
			title: t("settings.codexProfiles.modelUsageLimits", { name: bucket.displayName || bucket.limitId }),
			bucket,
		})),
	].filter(({ bucket }) => bucket.primary || bucket.secondary);
	const remainingPercent = codexCapacityRemainingPercent(capacity.usedPercent ?? capacity.overall?.primary?.usedPercent);
	const capacityParts = [capacity.plan, remainingPercent === undefined ? undefined : t("settings.codexProfiles.capacityRemaining", { percent: remainingPercent })].filter(Boolean);
	const summaryLabel = [capacityLabel, ...capacityParts].join(" · ");
	const showReason = capacity.freshness === "stale" || capacity.state === "unknown" || capacity.state === "unsupported";

	return (
		<div className="mt-2 rounded border border-border/70 bg-muted/30 text-xs">
			{groups.length > 0 ? (
				<button
					aria-expanded={expanded}
					aria-label={summaryLabel}
					className="flex w-full items-center justify-between gap-3 rounded px-2.5 py-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					onClick={() => setExpanded((current) => !current)}
					type="button"
				>
					<span className="min-w-0 truncate">
						<span className="font-medium text-foreground">{capacityLabel}</span>
						{capacityParts.length > 0 ? <span className="text-muted-foreground"> · {capacityParts.join(" · ")}</span> : null}
						{capacity.freshness === "checking" ? <LoaderCircle className="ml-1 inline size-3 animate-spin" aria-label={t("settings.codexProfiles.checking")} /> : null}
					</span>
					<ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
				</button>
			) : (
				<div className="px-2.5 py-2">
					<p className="font-medium text-foreground">{capacityLabel}{capacity.freshness === "checking" ? <LoaderCircle className="ml-1 inline size-3 animate-spin" aria-label={t("settings.codexProfiles.checking")} /> : null}</p>
					{capacityParts.length > 0 ? <p className="mt-0.5 text-muted-foreground">{capacityParts.join(" · ")}</p> : null}
					{showReason ? <p className="mt-0.5 text-muted-foreground">{capacity.reason}</p> : null}
				</div>
			)}
			{expanded ? (
				<div className="space-y-3 border-t border-border/70 px-2.5 py-2.5">
					{showReason ? <p className="text-muted-foreground">{capacity.reason}</p> : null}
					{groups.map((group) => <CodexCapacityLimitGroup key={group.id} title={group.title} bucket={group.bucket} />)}
				</div>
			) : null}
		</div>
	);
}

function CodexCapacityLimitGroup({ title, bucket }: { title: string; bucket: CodexCapacityBucket }) {
	const windows = [bucket.primary, bucket.secondary].filter((window): window is CodexCapacityWindow => Boolean(window));
	return (
		<section aria-label={title}>
			<h4 className="mb-1.5 text-xs font-medium text-foreground">{title}</h4>
			<div className="divide-y divide-border/70 overflow-hidden rounded-md border border-border/70 bg-background/35 px-2.5">
				{windows.map((window, index) => <CodexCapacityLimitWindow key={`${window.windowDurationMinutes ?? "unknown"}-${index}`} window={window} />)}
			</div>
		</section>
	);
}

function CodexCapacityLimitWindow({ window }: { window: CodexCapacityWindow }) {
	const { t } = useTranslation();
	const labelDescriptor = capacityWindowLabel(window.windowDurationMinutes);
	const label = labelDescriptor.count === undefined ? t(labelDescriptor.key) : t(labelDescriptor.key, { count: labelDescriptor.count });
	const remaining = Math.round(codexCapacityRemainingPercent(window.usedPercent) ?? 0);
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_minmax(7rem,10rem)_auto] items-center gap-3 py-2.5">
			<div className="min-w-0">
				<p className="font-medium text-foreground">{label}</p>
				{window.resetsAt ? <p className="mt-0.5 text-muted-foreground">{t("settings.codexProfiles.capacityResets", { value: new Date(window.resetsAt).toLocaleString() })}</p> : null}
			</div>
			<div
				aria-label={`${label}: ${t("settings.codexProfiles.capacityRemaining", { percent: remaining })}`}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={remaining}
				className="h-1.5 overflow-hidden rounded-full bg-border"
				role="progressbar"
			>
				<div className="h-full rounded-full bg-foreground transition-[width]" style={{ width: `${remaining}%` }} />
			</div>
			<p className="whitespace-nowrap text-right text-muted-foreground">{t("settings.codexProfiles.capacityRemaining", { percent: remaining })}</p>
		</div>
	);
}

type CapacityWindowLabel = {
	key: "settings.codexProfiles.capacityWindowUnknown" | "settings.codexProfiles.capacityWindowWeekly" | "settings.codexProfiles.capacityWindowDaily" | "settings.codexProfiles.capacityWindowDays" | "settings.codexProfiles.capacityWindowHours" | "settings.codexProfiles.capacityWindowMinutes";
	count?: number;
};

function capacityWindowLabel(minutes: number | null | undefined): CapacityWindowLabel {
	if (!minutes || minutes <= 0) return { key: "settings.codexProfiles.capacityWindowUnknown" };
	if (minutes === 10_080) return { key: "settings.codexProfiles.capacityWindowWeekly" };
	if (minutes === 1_440) return { key: "settings.codexProfiles.capacityWindowDaily" };
	if (minutes % 1_440 === 0) return { key: "settings.codexProfiles.capacityWindowDays", count: minutes / 1_440 };
	if (minutes % 60 === 0) return { key: "settings.codexProfiles.capacityWindowHours", count: minutes / 60 };
	return { key: "settings.codexProfiles.capacityWindowMinutes", count: minutes };
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
