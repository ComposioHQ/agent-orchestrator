import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, CircleDashed, Clock3, Download, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../../lib/bridge";
import { cn } from "../../lib/utils";
import { useUiStore } from "../../stores/ui-store";
import { useUpdateStatus } from "../../hooks/useUpdateStatus";
import type { UpdateChannel, UpdateSettings, UpdateState, UpdateStatus } from "../../../main/update-settings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsOptionMenu } from "./SettingsOptionMenu";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { captureRendererEvent, releaseChannelFrom, setReleaseChannelContext } from "../../lib/telemetry";

export const updateSettingsQueryKey = ["update-settings"] as const;

type PrimaryValue = UpdateChannel | "feature";

const DEFAULT_SETTINGS: UpdateSettings = { enabled: false, channel: "latest", nightlyAck: false, feature: null };

let updateRequestSequence = 0;

function nextUpdateRequestId(prefix = "feature-update"): string {
	updateRequestSequence += 1;
	return `${prefix}-${updateRequestSequence}`;
}

export function UpdatesSection({ titleHidden }: { titleHidden?: boolean } = {}) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: updateSettingsQueryKey,
		queryFn: () => aoBridge.updateSettings.get(),
	});

	const [form, setForm] = useState<UpdateSettings>(DEFAULT_SETTINGS);
	const formRef = useRef(form);
	formRef.current = form;
	const [showFeature, setShowFeature] = useState(false);
	const [pendingPin, setPendingPin] = useState<{ pr: number; title: string } | null>(null);
	const [manualCheckRequestId, setManualCheckRequestId] = useState<string | null>(null);
	const developerMode = useUiStore((state) => state.developerMode);

	const status = useUpdateStatus((next) => {
		setManualCheckRequestId((pending) =>
			pending !== null && next.requestId === pending && next.state !== "checking" ? null : pending,
		);
	});
	// Set only for the owned pin/home transition request, so unrelated hourly
	// updater events cannot auto-progress through download/install.
	const autoProgressRef = useRef<string | null>(null);
	const handledStatusRef = useRef<UpdateState | null>(null);

	useEffect(() => {
		if (query.data) setForm(query.data);
	}, [query.data]);

	useEffect(() => {
		const requestId = autoProgressRef.current;
		if (!requestId || status.requestId !== requestId) return;
		if (handledStatusRef.current === status.state) return;
		handledStatusRef.current = status.state;
		if (status.state === "available") {
			void aoBridge.updates.download(requestId);
		} else if (status.state === "downloaded") {
			void aoBridge.updates.install();
			autoProgressRef.current = null;
		} else if (status.state === "error" || status.state === "unsupported" || status.state === "not-available") {
			autoProgressRef.current = null;
		}
	}, [status]);

	const save = useMutation({
		mutationFn: async (next: UpdateSettings) => {
			await aoBridge.updateSettings.set(next);
			return next;
		},
		onSuccess: (next) => {
			setForm(next);
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		},
		onError: () => {
			const previous = queryClient.getQueryData<UpdateSettings>(updateSettingsQueryKey);
			if (previous) setForm(previous);
		},
	});

	const channelOptions: { value: PrimaryValue; label: string }[] = [
		{ value: "latest", label: t("settings.updates.channel.stable") },
		{ value: "nightly", label: t("settings.updates.channel.nightly") },
		{ value: "feature", label: t("settings.updates.channel.feature") },
	];
	const primaryValue: PrimaryValue = developerMode && (form.feature !== null || showFeature) ? "feature" : form.channel;

	const setEnabled = (enabled: boolean) => {
		const next = { ...formRef.current, enabled };
		setForm(next);
		save.mutate(next);
	};

	const handlePrimaryChannel = (value: PrimaryValue) => {
		if (!formRef.current.enabled) return;
		if (value === "feature") {
			setShowFeature(true);
			return;
		}
		setShowFeature(false);
		const next = {
			...formRef.current,
			channel: value,
			nightlyAck: value === "nightly",
			feature: null,
		};
		const from = releaseChannelFrom(formRef.current);
		const to = releaseChannelFrom(next);
		setForm(next);
		save.mutate(next);
		if (from !== to) {
			// Reported on the switch rather than inferred later, because someone who
			// moves to nightly and does not update yet is on nightly by intent while
			// still running a stable build.
			setReleaseChannelContext(to);
			void captureRendererEvent("ao.renderer.update_channel_changed", { from_channel: from, to_channel: to });
		}
	};

	const confirmPinBuild = async () => {
		if (!pendingPin) return;
		const { pr } = pendingPin;
		setPendingPin(null);
		const next = { ...formRef.current, feature: { pr } };
		setForm(next);
		const requestId = nextUpdateRequestId();
		autoProgressRef.current = requestId;
		handledStatusRef.current = null;
		try {
			await aoBridge.updates.check({ settings: next, requestId });
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		} catch {
			if (autoProgressRef.current === requestId) autoProgressRef.current = null;
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		}
	};

	const handleReturnToHome = async () => {
		setShowFeature(false);
		// Optimistic; the main process clears the pin against persisted state.
		setForm({ ...formRef.current, feature: null });
		const requestId = nextUpdateRequestId();
		autoProgressRef.current = requestId;
		handledStatusRef.current = null;
		try {
			// Single updater-serialized op: clears the pin and checks the home channel
			// atomically, so a concurrent settings-write cannot restore the pin.
			await aoBridge.updates.returnHome(requestId);
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		} catch {
			if (autoProgressRef.current === requestId) autoProgressRef.current = null;
			// The optimistic form update may now disagree with disk; re-sync to truth.
			void queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		}
	};

	const activeQuery = useQuery({
		queryKey: ["feature-active"],
		queryFn: () => aoBridge.featureBuilds.getActive(),
	});
	const activeBuild = activeQuery.data ?? null;
	// Show the escape hatch whenever a feature build is running or pinned.
	const featurePr = activeBuild?.pr ?? (developerMode ? null : (form.feature?.pr ?? null));

	return (
		<>
			<SettingsSection title={t("settings.updates")} sectionId="updates" titleHidden={titleHidden} grouped>
				<UpdateActions
					status={status}
					manualCheckRequestId={manualCheckRequestId}
					setManualCheckRequestId={setManualCheckRequestId}
				/>

				{featurePr != null && (
					<div className="mt-3 flex flex-col gap-2 rounded-(--radius-settings-panel) border border-[var(--color-border-settings-dialog)] bg-[var(--color-bg-settings-input)] p-1">
						<div className="settings-row-bar h-auto min-h-(--size-settings-row) flex-wrap gap-2">
							<Badge variant="accent">PR #{featurePr}</Badge>
							<span className="min-w-0 flex-1 text-sm leading-5 text-settings-label">
								{activeBuild
									? t("settings.updates.onFeatureBuild", { pr: featurePr })
									: t("settings.updates.featurePinned", { pr: featurePr })}
							</span>
							<Button type="button" variant="outline" size="sm" onClick={() => void handleReturnToHome()}>
								{form.channel === "nightly" ? t("settings.updates.returnToNightly") : t("settings.updates.returnToStable")}
							</Button>
						</div>
						<p className="px-(--size-settings-row-padding) pb-2 text-xs text-settings-muted">
							{t("settings.updates.featureTracking", { pr: featurePr })}
						</p>
					</div>
				)}

				<div className="mt-3 w-full overflow-hidden rounded-(--radius-settings-panel) border border-[var(--color-border-settings-dialog)] bg-[var(--color-bg-settings-input)] shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground)_4%,transparent)]">
					<SettingsRow label={t("settings.updates.automatic")}>
						<div className="flex items-center gap-3">
							<span className="text-xs text-settings-muted">
								{form.enabled ? t("settings.updates.enabled") : t("settings.updates.disabled")}
							</span>
							<Switch
								aria-label={t("settings.updates.automatic")}
								checked={form.enabled}
								onCheckedChange={setEnabled}
								disabled={save.isPending}
							/>
						</div>
					</SettingsRow>

					{form.enabled && (
						<div className="border-t border-[var(--color-border-settings-dialog)]">
							<SettingsRow label={t("settings.updates.channel")}>
								<SettingsOptionMenu
									aria-label={t("settings.updates.channel")}
									value={primaryValue}
									options={developerMode ? channelOptions : channelOptions.filter((option) => option.value !== "feature")}
									onChange={handlePrimaryChannel}
									disabled={save.isPending}
								/>
							</SettingsRow>

							{primaryValue === "feature" && (
								<FeatureBuildsSelect
									currentPr={form.feature?.pr ?? null}
									onPin={(pr, title) => setPendingPin({ pr, title })}
								/>
							)}

							{primaryValue === "nightly" && (
								<p className="nightly-warning flex items-start gap-2 px-(--size-settings-row-padding) pb-(--size-settings-row-padding) text-xs leading-row text-warning">
									<AlertTriangle className="mt-0.5 size-icon-sm shrink-0" aria-hidden="true" />
									<span>{t("settings.updates.nightlyWarning")}</span>
								</p>
							)}
						</div>
					)}
				</div>

				{save.isError && (
					<p className="mt-2 px-(--size-settings-row-padding) text-xs text-error">
						{save.error instanceof Error ? save.error.message : t("settings.updates.saveFailed")}
					</p>
				)}
			</SettingsSection>
			<ConfirmDialog
				open={pendingPin !== null}
				title={t("settings.updates.switchFeatureTitle")}
				description={pendingPin ? t("settings.updates.switchFeatureBody", pendingPin) : null}
				confirmLabel={t("settings.updates.confirm")}
				onConfirm={() => void confirmPinBuild()}
				onOpenChange={(open) => !open && setPendingPin(null)}
			/>
		</>
	);
}

function FeatureBuildsSelect({
	currentPr,
	onPin,
}: {
	currentPr: number | null;
	onPin: (pr: number, title: string) => void;
}) {
	const { t } = useTranslation();
	const buildsQuery = useQuery({ queryKey: ["feature-builds"], queryFn: () => aoBridge.featureBuilds.list() });
	const builds = buildsQuery.data ?? [];

	if (!buildsQuery.isLoading && builds.length === 0) {
		return <p className="px-3 text-xs text-settings-muted">{t("settings.updates.noFeatureReleases")}</p>;
	}

	return (
		<SettingsRow label={t("settings.updates.featureBuild")}>
			<SettingsOptionMenu
				aria-label={t("settings.updates.featureBuild")}
				value={currentPr === null ? "__none__" : currentPr.toString()}
				placeholder={t("settings.updates.selectFeature")}
				options={builds.map((build) => ({ value: build.pr.toString(), label: `PR #${build.pr}: ${build.title}` }))}
				disabled={buildsQuery.isLoading}
				onChange={(value) => {
					const build = builds.find((item) => item.pr === Number(value));
					if (build) onPin(build.pr, build.title);
				}}
			/>
		</SettingsRow>
	);
}

function UpdateActions({
	status,
	manualCheckRequestId,
	setManualCheckRequestId,
}: {
	status: UpdateStatus;
	manualCheckRequestId: string | null;
	setManualCheckRequestId: Dispatch<SetStateAction<string | null>>;
}) {
	const { t, i18n } = useTranslation();
	const version = useQuery({ queryKey: ["app-version"], queryFn: () => aoBridge.app.getVersion() });

	const manualCheckPending = manualCheckRequestId !== null;
	const checking = status.state === "checking" || manualCheckPending;
	const downloading = status.state === "downloading";
	const busy = checking || downloading;
	const displayStatus: UpdateStatus = manualCheckPending && status.state !== "checking" ? { ...status, state: "checking" } : status;
	const tone = updateStatusTone(displayStatus.state);
	const progress = Math.min(100, Math.max(0, displayStatus.percent ?? 0));
	const checkedAt = status.checkedAt
		? new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(status.checkedAt)
		: null;

	const checkNow = async () => {
		const requestId = nextUpdateRequestId("manual-update");
		setManualCheckRequestId(requestId);
		try {
			await aoBridge.updates.check({ requestId });
		} catch {
			// The main process publishes the actionable updater error state.
		} finally {
			setManualCheckRequestId((pending) => (pending === requestId ? null : pending));
		}
	};

	return (
		<div
			className="update-status-panel overflow-hidden rounded-(--radius-settings-panel) border border-[var(--color-border-settings-dialog)] bg-[var(--color-bg-settings-input)]"
			data-tone={tone}
		>
			<div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
				<div className="flex min-w-0 items-center gap-3">
					<div className="update-status-glyph flex size-9 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
						<UpdateStatusIcon status={displayStatus} />
					</div>

					<div
						id="update-status-line"
						role="status"
						aria-live="polite"
						aria-atomic="true"
						aria-busy={checking}
						className="min-w-0"
					>
						<UpdateStatusLine status={displayStatus} />
					</div>
				</div>

				<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end [&>button]:flex-1 sm:[&>button]:flex-none">
					{!checking && status.state === "available" && (
						<Button type="button" variant="primary" size="sm" onClick={() => void aoBridge.updates.download()}>
							{status.version ? t("settings.updates.updateTo", { version: `v${status.version}` }) : t("settings.updates.updateToLatest")}
						</Button>
					)}
					{!checking && status.state === "downloaded" && (
						<Button type="button" variant="primary" size="sm" onClick={() => void aoBridge.updates.install()}>
							{t("settings.updates.restartInstall")}
						</Button>
					)}
					<Button
						type="button"
						aria-label={checking ? t("settings.updates.checking") : t("settings.updates.check")}
						aria-describedby="update-status-line"
						variant="outline"
						size="sm"
						className="min-w-36"
						onClick={() => void checkNow()}
						disabled={busy}
					>
						{checking ? (
							<Loader2 className="size-icon-sm animate-spin motion-reduce:animate-none" aria-hidden="true" />
						) : (
							<RefreshCw className="size-icon-sm" aria-hidden="true" />
						)}
						{checking ? t("settings.updates.checking") : t("settings.updates.check")}
					</Button>
				</div>

				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border-settings-dialog)] pt-3 text-xs leading-4 text-settings-muted sm:col-span-2 sm:ml-12">
					<span className="min-w-0 font-mono tabular-nums sm:whitespace-nowrap" data-testid="app-version">
						{t("settings.updates.currentVersion", { version: version.data ? `v${version.data}` : "…" })}
					</span>
					{checkedAt && (
						<>
							<span className="hidden size-0.5 rounded-full bg-current opacity-50 sm:block" aria-hidden="true" />
							<span className="inline-flex items-center gap-1.5 tabular-nums" data-testid="update-checked-at">
								<Clock3 className="size-3" aria-hidden="true" />
								{t("settings.updates.lastChecked", { time: checkedAt })}
							</span>
						</>
					)}
				</div>
			</div>

			{displayStatus.state === "downloading" && (
				<div className="mx-4 mb-4 h-1 overflow-hidden rounded-full bg-foreground/8" aria-hidden="true">
					<div className="h-full origin-left rounded-full bg-primary" style={{ transform: `scaleX(${progress / 100})` }} />
				</div>
			)}

			{!status.staleCheckNudge && status.checksFailing && (
				<p className="mx-4 mb-4 flex items-start gap-2 border-t border-[var(--color-border-settings-dialog)] pt-3 text-xs leading-5 text-warning">
					<AlertTriangle className="mt-0.5 size-icon-sm shrink-0" aria-hidden="true" />
					<span>{t("settings.updates.checksFailing")}</span>
				</p>
			)}

			{status.staleCheckNudge && (
				<p className="mx-4 mb-4 flex items-start gap-2 border-t border-[var(--color-border-settings-dialog)] pt-3 text-xs leading-5 text-warning">
					<AlertTriangle className="mt-0.5 size-icon-sm shrink-0" aria-hidden="true" />
					<span>{t("settings.updates.networkStale")}</span>
				</p>
			)}
		</div>
	);
}

function UpdateStatusLine({ status }: { status: UpdateStatus }) {
	const { t } = useTranslation();
	let className = "text-settings-muted";
	let label: string;

	switch (status.state) {
		case "checking":
			label = t("settings.updates.checking");
			break;
		case "available":
			className = "text-settings-label";
			label = t("settings.updates.available", { version: status.version ? ` (v${status.version})` : "" });
			break;
		case "downloading":
			className = "text-settings-label tabular-nums";
			label = t("settings.updates.downloading", { percent: status.percent ?? 0 });
			break;
		case "downloaded":
			className = "text-success";
			label = t("settings.updates.downloaded");
			break;
		case "not-available":
			className = "text-success";
			label = t("settings.updates.latest");
			break;
		case "unsupported":
			label = status.message ?? t("settings.updates.needInstalledApp");
			break;
		case "error":
			className = "text-error";
			label = status.netError
				? t("settings.updates.netErrorRestartGuidance")
				: status.message ?? t("settings.updates.updateFailed");
			break;
		default:
			label = t("settings.updates.notChecked");
	}

	return (
		<p className={cn("text-pretty text-sm font-medium leading-5", className)}>{label}</p>
	);
}

function UpdateStatusIcon({ status }: { status: UpdateStatus }) {
	const className = "size-5";
	switch (status.state) {
		case "checking":
			return <Loader2 className={cn(className, "animate-spin motion-reduce:animate-none")} />;
		case "available":
		case "downloading":
			return <Download className={className} />;
		case "downloaded":
		case "not-available":
			return <CheckCircle2 className={className} />;
		case "unsupported":
			return <AlertTriangle className={className} />;
		case "error":
			return <AlertCircle className={className} />;
		case "idle":
			return <CircleDashed className={className} />;
	}
}

function updateStatusTone(state: UpdateState): "neutral" | "accent" | "success" | "warning" | "error" {
	switch (state) {
		case "checking":
		case "available":
		case "downloading":
			return "accent";
		case "downloaded":
		case "not-available":
			return "success";
		case "unsupported":
			return "warning";
		case "error":
			return "error";
		case "idle":
			return "neutral";
	}
}
