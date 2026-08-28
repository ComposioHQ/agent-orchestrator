import { CircleAlert, CircleCheck, LoaderCircle, Plus, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
	CODEX_PROFILE_DAEMON_RESET_EVENT,
	cacheCodexProfile,
	cancelCodexProfileLogin,
	createCodexProfile,
	startCodexProfileLogin,
	useCodexProfileLoginEvents,
	useCodexProfilesQuery,
	useEnsureCodexProfiles,
	type CodexProfile,
	type CodexProfileLoginEvent,
	type CodexProfileLoginStart,
} from "../../hooks/useCodexProfilesQuery";
import { codexProfileLoginsQueryKey } from "../../hooks/codex-profile-cache";
import { aoBridge } from "../../lib/bridge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./SettingsSection";

type LoginView = CodexProfileLoginStart & { reason?: string };

export function CodexProfilesSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const profilesQuery = useCodexProfilesQuery();
	useEnsureCodexProfiles(true);
	const [adding, setAdding] = useState(false);
	const [label, setLabel] = useState("");
	const [busyProfile, setBusyProfile] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [logins, setLogins] = useState<Record<string, LoginView>>(
		() => queryClient.getQueryData<Record<string, LoginView>>(codexProfileLoginsQueryKey) ?? {},
	);

	useEffect(() => {
		queryClient.setQueryData(codexProfileLoginsQueryKey, logins);
	}, [logins, queryClient]);

	useEffect(() => {
		const reset = () => setLogins({});
		window.addEventListener(CODEX_PROFILE_DAEMON_RESET_EVENT, reset);
		return () => window.removeEventListener(CODEX_PROFILE_DAEMON_RESET_EVENT, reset);
	}, []);

	const beginLogin = useCallback(async (profileId: string) => {
		setBusyProfile(profileId);
		setError(null);
		try {
			const operation = await startCodexProfileLogin(profileId);
			setLogins((current) => ({ ...current, [profileId]: { ...operation, reason: t("settings.codexProfiles.waiting") } }));
			await aoBridge.app.openExternal(operation.authUrl);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("settings.codexProfiles.loginFailed"));
		} finally {
			setBusyProfile(null);
		}
	}, [t]);

	const createProfile = async () => {
		const nextLabel = label.trim();
		if (!nextLabel) return;
		setBusyProfile("create");
		setError(null);
		try {
			const profile = await createCodexProfile(nextLabel);
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

	const onLoginEvent = useCallback((event: CodexProfileLoginEvent) => {
		setLogins((current) => {
			const prior = current[event.profileId];
			if (!prior) return current;
			return { ...current, [event.profileId]: { ...prior, status: event.status, reason: event.reason } };
		});
	}, []);

	const browserLogin = profilesQuery.data?.capabilities.browserLogin;
	const loginSupported = browserLogin?.state === "supported";

	return (
		<SettingsSection title={t("settings.codexProfiles.title")} sectionId="codex-profiles" titleHidden={titleHidden}>
			<div className="flex flex-col gap-3 rounded-md bg-[var(--color-bg-settings-row)] p-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="text-sm font-medium text-foreground">{t("settings.codexProfiles.heading")}</p>
						<p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("settings.codexProfiles.description")}</p>
					</div>
					<Button type="button" size="sm" onClick={() => setAdding(true)} disabled={!loginSupported || adding}>
						<Plus aria-hidden="true" /> {t("settings.codexProfiles.add")}
					</Button>
				</div>

				{browserLogin && browserLogin.state !== "supported" ? (
					<div className="flex gap-2 rounded-md border border-border bg-background/50 p-3 text-xs text-muted-foreground">
						<CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						<span>{browserLogin.reason}</span>
					</div>
				) : null}

				{adding ? (
					<div className="flex items-center gap-2">
						<Input aria-label={t("settings.codexProfiles.label")} value={label} maxLength={80} autoFocus onChange={(event) => setLabel(event.target.value)} placeholder={t("settings.codexProfiles.labelPlaceholder")} />
						<Button type="button" size="sm" onClick={() => void createProfile()} disabled={!label.trim() || busyProfile === "create"}>{t("settings.codexProfiles.create")}</Button>
						<Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); setLabel(""); }}>{t("settings.codexProfiles.cancel")}</Button>
					</div>
				) : null}

				{error ? <p role="alert" className="text-xs text-error">{error}</p> : null}
				{profilesQuery.isLoading ? <p className="text-xs text-muted-foreground">{t("settings.codexProfiles.loading")}</p> : null}
				{profilesQuery.data?.profiles.map((profile) => (
					<CodexProfileRow
						key={profile.id}
						profile={profile}
						login={logins[profile.id]}
						busy={busyProfile === profile.id}
						loginSupported={loginSupported}
						onLogin={() => void beginLogin(profile.id)}
						onCancel={() => {
							const operation = logins[profile.id];
							if (!operation) return;
							void cancelCodexProfileLogin(profile.id, operation.operationId)
								.then(onLoginEvent)
								.catch((cause) => setError(cause instanceof Error ? cause.message : t("settings.codexProfiles.cancelFailed")));
						}}
						onOpen={() => { const operation = logins[profile.id]; if (operation) void aoBridge.app.openExternal(operation.authUrl); }}
						onEvent={onLoginEvent}
					/>
				))}
			</div>
		</SettingsSection>
	);
}

function CodexProfileRow({ profile, login, busy, loginSupported, onLogin, onCancel, onOpen, onEvent }: {
	profile: CodexProfile;
	login?: LoginView;
	busy: boolean;
	loginSupported: boolean;
	onLogin: () => void;
	onCancel: () => void;
	onOpen: () => void;
	onEvent: (event: CodexProfileLoginEvent) => void;
}) {
	const { t } = useTranslation();
	useCodexProfileLoginEvents(login?.status === "pending" ? login : null, onEvent);
	const auth = profile.authentication;
	const checking = auth.freshness === "checking";
	const authLabel = auth.state === "authorized"
		? t("settings.codexProfiles.signedIn")
		: auth.state === "unauthorized"
			? t("settings.codexProfiles.signedOut")
			: auth.state === "not_applicable"
				? t("settings.codexProfiles.notRequired")
				: t("settings.codexProfiles.unknown");
	const canLogin = profile.status === "valid" && auth.state === "unauthorized" && loginSupported;
	const retryableLogin = auth.state === "unauthorized" && (login?.status === "failed" || login?.status === "cancelled");

	return (
		<div className="rounded-md border border-border bg-background/40 p-3" data-profile-id={profile.id}>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 gap-3">
					<div className="mt-0.5 rounded-md bg-muted p-2"><UserRound className="size-4" aria-hidden="true" /></div>
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
						{login?.reason ? <p className="mt-1 text-xs text-muted-foreground">{login.reason}</p> : null}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{login?.status === "pending" ? <>
						<Button type="button" size="sm" variant="outline" onClick={onOpen}>{t("settings.codexProfiles.openBrowser")}</Button>
						<Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t("settings.codexProfiles.cancel")}</Button>
					</> : canLogin || retryableLogin ? (
						<Button type="button" size="sm" variant="outline" onClick={onLogin} disabled={busy}>{retryableLogin ? t("settings.codexProfiles.retry") : t("settings.codexProfiles.signIn")}</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}
