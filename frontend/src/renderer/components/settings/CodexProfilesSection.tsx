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
				{profilesQuery.data?.profiles?.map((profile) => (
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
	const capacityParts = [capacity.plan, capacity.usedPercent === undefined || capacity.usedPercent === null ? undefined : `${capacity.usedPercent}%`, capacity.resetsAt ? t("settings.codexProfiles.capacityResets", { value: new Date(capacity.resetsAt).toLocaleString() }) : undefined].filter(Boolean);

	return (
		<div className="rounded-md border border-border bg-background/40 p-3" data-profile-id={profile.id}>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 gap-3">
					<UserRound data-testid="codex-profile-icon" className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<p className="truncate text-sm font-medium">{profile.label}</p>
							{profile.id === "existing" ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("settings.codexProfiles.existing")}</span> : null}
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
							<div className="mt-2 rounded border border-border/70 bg-muted/30 px-2.5 py-2 text-xs">
								<p className="font-medium text-foreground">{capacityLabel}{capacity.freshness === "checking" ? <LoaderCircle className="ml-1 inline size-3 animate-spin" aria-label={t("settings.codexProfiles.checking")} /> : null}</p>
								{capacityParts.length > 0 ? <p className="mt-0.5 text-muted-foreground">{capacityParts.join(" · ")}</p> : null}
								{capacity.freshness === "stale" || capacity.state === "unknown" || capacity.state === "unsupported" ? <p className="mt-0.5 text-muted-foreground">{capacity.reason}</p> : null}
							</div>
						) : null}
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
