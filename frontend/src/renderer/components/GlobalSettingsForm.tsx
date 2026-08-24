import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import type { GlobalSettingsSection as GlobalSettingsPage } from "../stores/ui-store";
import { GeneralSettingsSection } from "./settings/GeneralSettingsSection";
import { ConnectMobileContent } from "./settings/ConnectMobileContent";
import { KeyboardShortcutsContent } from "./settings/KeyboardShortcutsContent";
import { MobileDevicesSection } from "./settings/MobileDevicesSection";
import { ReportProblemContent } from "./settings/ReportProblemContent";
import { SettingsSection } from "./settings/SettingsSection";

const UpdatesSection = lazy(async () => {
	const module = await import("./settings/UpdatesSection");
	return { default: module.UpdatesSection };
});

export type GlobalSettingsSection = GlobalSettingsPage | "all";

/** Full-width panel for page-level content (forms, editors) — matches the
 *  grouped-row surface so pages read as one coherent family. */
function SettingsContentPanel({ children }: { children: React.ReactNode }) {
	return <div className="rounded-md bg-[var(--color-bg-settings-row)] px-4 py-4">{children}</div>;
}

export function GlobalSettingsForm({
	section = "all",
}: {
	section?: GlobalSettingsSection;
}) {
	const { t } = useTranslation();
	const all = section === "all";
	// One section per page means the dialog header already names it, so a
	// leading in-page heading would just repeat that title.
	const titleHidden = !all;

	return (
		<div
			aria-label={t("settings.title")}
			className="flex w-full flex-col gap-(--size-settings-section-gap)"
			data-testid="settings-page"
		>
			{(all || section === "general") && <GeneralSettingsSection titleHidden={titleHidden} />}

			{(all || section === "mobile") && (
				<SettingsSection title={t("settings.mobile")} titleHidden={titleHidden}>
					<div className="rounded-md bg-[var(--color-bg-settings-row)] px-4 pb-4 pt-0">
						<ConnectMobileContent active />
						<MobileDevicesSection />
					</div>
				</SettingsSection>
			)}

			{(all || section === "shortcuts") && (
				<SettingsSection title={t("settings.keyboardShortcuts")} titleHidden={titleHidden}>
					<SettingsContentPanel>
						<KeyboardShortcutsContent active />
					</SettingsContentPanel>
				</SettingsSection>
			)}

			{(all || section === "updates") && (
				<Suspense fallback={<UpdatesSectionSkeleton titleHidden={titleHidden} />}>
					<UpdatesSection titleHidden={titleHidden} />
				</Suspense>
			)}

			{(all || section === "help") && (
				<SettingsSection title={t("settings.reportProblem")} titleHidden={titleHidden}>
					<SettingsContentPanel>
						<ReportProblemContent active />
					</SettingsContentPanel>
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
