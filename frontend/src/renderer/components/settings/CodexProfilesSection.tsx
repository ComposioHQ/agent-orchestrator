import { CircleAlert, CircleCheck, LoaderCircle, Plus, UserRound } from "lucide-react";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
	cacheCodexProfile,
	createCodexProfile,
	openCodexProfileLoginTerminal,
	useCodexProfilesQuery,
	useEnsureCodexProfiles,
	type CodexProfile,
} from "../../hooks/useCodexProfilesQuery";
import { shellTerminalsQueryKey } from "../../hooks/useShellTerminals";
import { useUiStore } from "../../stores/ui-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./SettingsSection";

export function CodexProfilesSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const profilesQuery = useCodexProfilesQuery();
	useEnsureCodexProfiles(true);
	const [adding, setAdding] = useState(false);
	const [label, setLabel] = useState("");
	const [busyProfile, setBusyProfile] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const setActiveShellTerminal = useUiStore((state) => state.setActiveShellTerminal);
	const monitorLoginTerminal = useUiStore((state) => state.monitorCodexProfileLoginTerminal);
	const closeSettings = useUiStore((state) => state.closeSettings);

	const beginLogin = useCallback(async (profileId: string) => {
		setBusyProfile(profileId);
		setError(null);
		try {
			const started = await openCodexProfileLoginTerminal(profileId);
			void queryClient.invalidateQueries({ queryKey: shellTerminalsQueryKey });
			setActiveShellTerminal(started.shellTerminal.handleId);
			monitorLoginTerminal(started.profileId, started.shellTerminal.handleId);
			closeSettings();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("settings.codexProfiles.loginFailed"));
		} finally {
			setBusyProfile(null);
		}
	}, [closeSettings, monitorLoginTerminal, queryClient, setActiveShellTerminal, t]);

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

	return (
		<SettingsSection title={t("settings.codexProfiles.title")} sectionId="codex-profiles" titleHidden={titleHidden}>
			<div className="flex flex-col gap-3 rounded-md bg-[var(--color-bg-settings-row)] p-4">
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="text-sm font-medium text-foreground">{t("settings.codexProfiles.heading")}</p>
						<p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("settings.codexProfiles.description")}</p>
					</div>
					<Button type="button" size="sm" onClick={() => setAdding(true)} disabled={adding}>
						<Plus aria-hidden="true" /> {t("settings.codexProfiles.add")}
					</Button>
				</div>

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
						busy={busyProfile === profile.id}
						onLogin={() => void beginLogin(profile.id)}
					/>
				))}
			</div>
		</SettingsSection>
	);
}

function CodexProfileRow({ profile, busy, onLogin }: {
	profile: CodexProfile;
	busy: boolean;
	onLogin: () => void;
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
		<div className="rounded-md border border-border bg-background/40 p-3" data-profile-id={profile.id}>
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
					{canLogin ? (
						<Button type="button" size="sm" variant="outline" onClick={onLogin} disabled={busy}>{t("settings.codexProfiles.signIn")}</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}
