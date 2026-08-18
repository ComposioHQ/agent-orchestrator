import { TabletSmartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../stores/ui-store";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

// Single opt-in toggle that reveals the Emulator tab in the session
// inspector. Off by default: the Android emulator is a heavy feature (a
// multi-GB SDK download, a full VM running in the background), not something
// every session needs taking up a tab. Persisted via the ui-store.
export function EmulatorSettingsSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const emulatorEnabled = useUiStore((state) => state.emulatorEnabled);
	const setEmulatorEnabled = useUiStore((state) => state.setEmulatorEnabled);

	return (
		<SettingsSection title={t("settings.emulator")} sectionId="emulator" titleHidden={titleHidden}>
			<SettingsRow icon={TabletSmartphone} label={t("settings.emulator")}>
				<Switch aria-label={t("settings.emulator")} checked={emulatorEnabled} onCheckedChange={setEmulatorEnabled} />
			</SettingsRow>
			<p className="px-2 pb-2 text-xs leading-relaxed text-muted-foreground">{t("settings.emulator.description")}</p>
		</SettingsSection>
	);
}
