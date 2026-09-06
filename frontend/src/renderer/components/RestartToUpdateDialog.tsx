import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../lib/bridge";
import { parseNightlyVersion } from "../lib/build-channel";
import { sessionsAtRiskFromInstall } from "../lib/update-install-risk";
import { useUpdateStatus } from "../hooks/useUpdateStatus";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { useUiStore } from "../stores/ui-store";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	settingsDialogBodyClass,
	settingsDialogContentClass,
	settingsDialogFooterClass,
	settingsDialogHeaderClass,
} from "./ui/dialog";

/**
 * Confirmation for restarting into a staged build.
 *
 * The sidebar row and the Settings button used to call updates.install()
 * straight through, so a single click quit the app. That is fine for the
 * sessions that survive a quit and destructive for the ones that do not, and
 * the user had no way to tell which they had. This shows what the build
 * contains and names the sessions that would actually lose a turn.
 */
export function RestartToUpdateDialog() {
	const open = useUiStore((state) => state.updateInstallPromptOpen);
	// Gate before any other hook runs. This is mounted for the whole shell's
	// lifetime but visible almost never, and the body below subscribes to the
	// update-status channel and reads the workspace list — neither is worth
	// paying for on every shell mount, and both would couple every shell test
	// to bridge mocks it has no reason to provide.
	if (!open) return null;
	return <RestartToUpdateDialogBody />;
}

function RestartToUpdateDialogBody() {
	const { t, i18n } = useTranslation();
	const close = useUiStore((state) => state.closeUpdateInstallPrompt);
	const status = useUpdateStatus();
	// Subscription off: this only ever reads the already-cached workspace list,
	// and the dialog must not open a second live workspace stream.
	const workspace = useWorkspaceQuery({ subscribed: false });

	const [pending, setPending] = useState(false);
	const [failureDetail, setFailureDetail] = useState<string | null>(null);
	const installing = useRef(false);
	const mounted = useRef(true);
	// Keep the confirmed build details visible when preparation emits a status
	// without release metadata (for example a download progress event).
	const [confirmedBuild, setConfirmedBuild] = useState<{
		version?: string;
		releaseNotes?: string;
	} | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const version = confirmedBuild?.version ?? status.staged?.version ?? status.version;
	const releaseNotes = confirmedBuild?.releaseNotes ?? status.releaseNotes;
	const percent = status.state === "downloading" && typeof status.percent === "number" && Number.isFinite(status.percent)
		? Math.min(100, Math.max(0, status.percent))
		: undefined;
	const progressLabel = percent === undefined
		? t("update.restart.preparing")
		: t("settings.updates.downloading", { percent: Math.round(percent) });
	const nightly = parseNightlyVersion(version);
	const buildLabel = nightly
		? t("shell.nightlyBuild", {
				version: nightly.base,
				date: new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
					month: "short",
					day: "numeric",
				}).format(nightly.builtAt),
			})
		: version
			? `v${version}`
			: null;

	const atRisk = sessionsAtRiskFromInstall(
		(workspace.data ?? []).flatMap((project) => project.sessions),
	);

	const confirm = async () => {
		// A ref guards same-turn clicks before React commits the disabled state.
		if (installing.current) return;
		installing.current = true;
		setConfirmedBuild({ version, releaseNotes });
		setPending(true);
		setFailureDetail(null);
		try {
			await aoBridge.updates.install();
			if (mounted.current) close();
		} catch (error) {
			if (mounted.current) {
				// Electron wraps IPC rejections with transport details. Keep the
				// actionable main-process message, rendered as bounded plain text.
				setFailureDetail(error instanceof Error
					? error.message.replace(/^Error invoking remote method ['"][^'"]+['"]: (?:Error: )?/, "").trim().slice(0, 1000)
					: "");
			}
		} finally {
			installing.current = false;
			if (mounted.current) setPending(false);
		}
	};

	return (
		<Dialog open onOpenChange={(next) => !next && !installing.current && close()}>
			<DialogContent
				className={settingsDialogContentClass}
				data-testid="restart-to-update-dialog"
				showCloseButton={!pending}
				onEscapeKeyDown={(event) => {
					if (installing.current) event.preventDefault();
				}}
				onInteractOutside={(event) => {
					if (installing.current) event.preventDefault();
				}}
			>
				<div className={settingsDialogHeaderClass}>
					<DialogTitle>{t("update.restart.title")}</DialogTitle>
					{buildLabel && <DialogDescription>{buildLabel}</DialogDescription>}
				</div>

				<div className={settingsDialogBodyClass}>
					{atRisk.length > 0 && (
						<div
							className="mb-4 rounded-md border border-warning/30 bg-warning/8 px-3 py-2.5"
							data-testid="restart-sessions-warning"
						>
							<p className="flex items-start gap-2 text-xs font-medium leading-5 text-warning">
								<AlertTriangle className="mt-0.5 size-icon-sm shrink-0" aria-hidden="true" />
								<span className="min-w-0">
									{t("update.restart.sessionsTitle", { count: atRisk.length })}
								</span>
							</p>
							<ul className="mt-2 space-y-1 pl-6">
								{atRisk.map((session) => (
									<li key={session.id} className="truncate text-xs leading-4 text-settings-label">
										{session.workspaceName} · {session.title}
									</li>
								))}
							</ul>
							<p className="mt-2 pl-6 text-xs leading-4 text-settings-muted">
								{t("update.restart.sessionsBody")}
							</p>
						</div>
					)}

					<p className="text-caption font-medium uppercase tracking-wide text-settings-muted">
						{t("update.restart.whatsNew")}
					</p>
					{releaseNotes ? (
						// Plain text on purpose. The notes are the remote release body,
						// sanitized in the main process; nothing here injects markup.
						<p className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-line text-pretty text-sm leading-5 text-settings-label">
							{releaseNotes}
						</p>
					) : (
						<p className="mt-1.5 text-sm leading-5 text-settings-muted">{t("update.restart.noNotes")}</p>
					)}

					{pending && (
						<div className="space-y-2">
							<p role="status" className="text-sm text-settings-label">{progressLabel}</p>
							<div
								role="progressbar"
								aria-label={progressLabel}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={percent}
								className="h-2 overflow-hidden rounded-full bg-muted"
							>
								<div
									className={percent === undefined
										? "h-full w-full animate-pulse bg-primary/30 motion-reduce:animate-none"
										: "h-full bg-primary"}
									style={percent === undefined ? undefined : { width: `${percent}%` }}
								/>
							</div>
						</div>
					)}
					{failureDetail !== null && (
						<div role="alert" className="space-y-1 text-sm text-destructive">
							<p>{t("update.restart.prepareFailed")}</p>
							{failureDetail && <p className="whitespace-pre-line break-words">{failureDetail}</p>}
						</div>
					)}
					<p className="mt-2 text-xs leading-4 text-settings-muted">{t("update.restart.installsOnQuit")}</p>
				</div>

				<div className={settingsDialogFooterClass}>
					<Button type="button" variant="outline" size="sm" onClick={close} disabled={pending}>
						{t("confirm.cancel")}
					</Button>
					<Button type="button" variant="primary" size="sm" onClick={confirm} disabled={pending}>
						{t("update.restart.confirm")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
