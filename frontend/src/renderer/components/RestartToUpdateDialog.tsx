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

	const staged = status.staged;
	const version = staged?.version ?? status.version;
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

	const confirm = () => {
		close();
		void aoBridge.updates.install();
	};

	return (
		<Dialog open onOpenChange={(next) => !next && close()}>
			<DialogContent className={settingsDialogContentClass} data-testid="restart-to-update-dialog">
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
					{status.releaseNotes ? (
						// Plain text on purpose. The notes are the remote release body,
						// sanitized in the main process; nothing here injects markup.
						<p className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-line text-pretty text-sm leading-5 text-settings-label">
							{status.releaseNotes}
						</p>
					) : (
						<p className="mt-1.5 text-sm leading-5 text-settings-muted">{t("update.restart.noNotes")}</p>
					)}

					<p className="mt-4 text-xs leading-4 text-settings-muted">{t("update.restart.installsOnQuit")}</p>
				</div>

				<div className={settingsDialogFooterClass}>
					<Button type="button" variant="outline" size="sm" onClick={close}>
						{t("confirm.cancel")}
					</Button>
					<Button type="button" variant="primary" size="sm" onClick={confirm}>
						{t("update.restart.confirm")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
