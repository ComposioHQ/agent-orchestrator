import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { GeneralSettingsSection } from "./settings/GeneralSettingsSection";
import { KeyboardShortcutsContent } from "./settings/KeyboardShortcutsContent";
import { ReportProblemContent } from "./settings/ReportProblemContent";
import { SettingsExpandableRow } from "./settings/SettingsRow";
import { SettingsSection } from "./settings/SettingsSection";

const UpdatesSection = lazy(async () => {
	const module = await import("./settings/UpdatesSection");
	return { default: module.UpdatesSection };
});

export type GlobalSettingsSection = "general" | "updates" | "help" | "all";

export function GlobalSettingsForm({
	section = "all",
}: {
	section?: GlobalSettingsSection;
}) {
	const { t } = useTranslation();
	const leadingTitleHidden = section !== "all";

	return (
		<div
			aria-label={t("settings.title")}
			className="flex w-full flex-col gap-(--size-settings-section-gap)"
			data-testid="settings-page"
		>
			{(section === "all" || section === "general") && (
				<>
					<GeneralSettingsSection titleHidden={leadingTitleHidden} />
					<SettingsSection title={t("settings.preferences")} grouped>
						<SettingsExpandableRow label={t("settings.keyboardShortcuts")}>
							{(open) => <KeyboardShortcutsContent active={open} />}
						</SettingsExpandableRow>
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
					<SettingsExpandableRow label={t("settings.reportProblem")}>
						{(open) => <ReportProblemContent active={open} />}
					</SettingsExpandableRow>
				</SettingsSection>
			)}
		</div>
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
