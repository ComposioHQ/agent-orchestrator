import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { GeneralSettingsSection } from "./settings/GeneralSettingsSection";
import { ReportProblemDialog } from "./settings/ReportProblemDialog";
import { SettingsLinkRow } from "./settings/SettingsRow";
import { SettingsSection } from "./settings/SettingsSection";

const UpdatesSection = lazy(async () => {
	const module = await import("./settings/UpdatesSection");
	return { default: module.UpdatesSection };
});

export type GlobalSettingsSection = "general" | "updates" | "help" | "all";

export function GlobalSettingsForm({
	section = "all",
	onOpenKeyboardShortcuts,
	onOpenConnectMobile,
}: {
	section?: GlobalSettingsSection;
	onOpenKeyboardShortcuts?: () => void;
	onOpenConnectMobile?: () => void;
}) {
	const { t } = useTranslation();
	const [reportProblemOpen, setReportProblemOpen] = useState(false);
	// One section per page means the dialog header already names it, so the
	// page's leading heading would just repeat that title. Only "all" (no
	// single-page header) shows every section's own heading.
	const leadingTitleHidden = section !== "all";

	return (
		<>
			<div
				aria-label={t("settings.title")}
				className="flex w-full flex-col gap-(--size-settings-section-gap)"
				data-testid="settings-page"
			>
				{(section === "all" || section === "general") && (
					<>
						<GeneralSettingsSection
							onConnectMobile={() => onOpenConnectMobile?.()}
							titleHidden={leadingTitleHidden}
						/>
						<SettingsSection title={t("settings.preferences")} grouped>
							<SettingsLinkRow
								label={t("settings.keyboardShortcuts")}
								onClick={() => onOpenKeyboardShortcuts?.()}
							/>
						</SettingsSection>
					</>
				)}
				{(section === "all" || section === "updates") && (
					<Suspense fallback={<UpdatesSectionSkeleton titleHidden={leadingTitleHidden} />}>
						<UpdatesSection titleHidden={leadingTitleHidden} />
					</Suspense>
				)}
				{(section === "all" || section === "help") && (
					<SettingsSection title={t("settings.getHelp")} titleHidden={leadingTitleHidden} grouped>
						<SettingsLinkRow label={t("settings.reportProblem")} onClick={() => setReportProblemOpen(true)} />
					</SettingsSection>
				)}
			</div>
			<ReportProblemDialog open={reportProblemOpen} onOpenChange={setReportProblemOpen} />
		</>
	);
}

function UpdatesSectionSkeleton({ titleHidden }: { titleHidden: boolean }) {
	return (
		<section className="flex w-full flex-col gap-(--size-settings-section-inner-gap)" aria-busy="true">
			{!titleHidden && <div className="mx-3 h-4 w-16 animate-pulse rounded bg-foreground/8 motion-reduce:animate-none" />}
			<div className="h-32 w-full animate-pulse rounded-(--radius-settings-panel) border border-[var(--color-border-settings-dialog)] bg-[var(--color-bg-settings-input)] motion-reduce:animate-none" />
		</section>
	);
}
