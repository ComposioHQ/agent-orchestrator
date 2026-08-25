import { useTranslation } from "react-i18next";
import type { ThemePreference, ThemeStyle } from "../../lib/theme";
import type { AppLocale } from "../../i18n";
import { useLocaleStore } from "../../stores/locale-store";
import { useSoundNotificationsStore } from "../../stores/sound-notifications-store";
import { useCloudBetaStore } from "../../stores/cloud-beta-store";
import { useCloudSession } from "../../lib/cloud-session";
import { useUiStore } from "../../stores/ui-store";
import { SettingsOptionMenu, type SettingsOption } from "./SettingsOptionMenu";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { Switch } from "../ui/switch";
import { cn } from "../../lib/utils";
import { useSettings, useUpdateSessionInterface } from "../../hooks/useSettings";
import type { SessionMode } from "../../types/workspace";

/**
 * Default interface for new sessions. Daemon-owned so `ao spawn` and mobile
 * resolve the same value. Only affects sessions created afterwards — a
 * session's interface is fixed when it is born.
 */
function SessionInterfaceRow() {
	const { t } = useTranslation();
	const { settings, isLoading, error } = useSettings();
	const { update, saving, error: saveError } = useUpdateSessionInterface();
	const interfaceOptions = [
		{ value: "tui", label: t("settings.sessionInterface.terminal") },
		{ value: "chat", label: t("settings.sessionInterface.chat") },
	] satisfies SettingsOption<SessionMode>[];

	const chatAvailable = (settings?.chatHarnesses.length ?? 0) > 0;
	// Silent when everything works; speak up only when the control is limited
	// (no chat-capable agent installed) or a save failed.
	const note = saveError ?? error ?? (!chatAvailable ? t("settings.sessionInterface.unavailable") : null);

\treturn (
\t\t<>
\t\t\t{/* Appearance */}
\t\t\t<SettingsSection title={t("settings.appearance")} titleHidden={titleHidden} grouped>
\t\t\t\t<SettingsRow label={t("settings.theme")}>
\t\t\t\t\t<div className="flex items-center gap-1.5">
\t\t\t\t\t\t<SettingsOptionMenu
\t\t\t\t\t\t\taria-label={t("settings.colorTheme")}
\t\t\t\t\t\t\tvalue={themeStyle}
\t\t\t\t\t\t\toptions={COLOR_THEME_OPTIONS}
\t\t\t\t\t\t\tonChange={setThemeStyle}
\t\t\t\t\t\t/>
\t\t\t\t\t\t<SettingsOptionMenu
\t\t\t\t\t\t\taria-label={t("settings.theme")}
\t\t\t\t\t\t\tvalue={themePreference}
\t\t\t\t\t\t\toptions={themeOptions}
\t\t\t\t\t\t\tonChange={setThemePreference}
\t\t\t\t\t\t/>
\t\t\t\t\t</div>
\t\t\t\t</SettingsRow>
\t\t\t\t<SettingsRow label={t("settings.language")}>
\t\t\t\t\t<SettingsOptionMenu
\t\t\t\t\t\taria-label={t("settings.language")}
\t\t\t\t\t\tdisabled={localeSaving}
\t\t\t\t\t\tvalue={locale}
\t\t\t\t\t\toptions={languageOptions}
\t\t\t\t\t\tonChange={(next) => {
\t\t\t\t\t\t\tvoid setLocale(next);
\t\t\t\t\t\t}}
\t\t\t\t\t/>
\t\t\t\t</SettingsRow>
\t\t\t\t{localeSaveError ? (
\t\t\t\t\t<p role="alert" className="px-3 text-caption leading-4 text-error">
\t\t\t\t\t\t{t("settings.language.saveFailed")}
\t\t\t\t\t</p>
\t\t\t\t) : null}
\t\t\t</SettingsSection>

\t\t\t{/* Sessions */}
\t\t\t<SettingsSection title={t("settings.sessions")} grouped>
\t\t\t\t<SessionInterfaceRow />
\t\t\t\t<SettingsRow label={t("settings.soundNotifications")}>
\t\t\t\t\t<Switch
\t\t\t\t\t\taria-label={t("settings.soundNotifications")}
\t\t\t\t\t\tchecked={soundNotificationsEnabled}
\t\t\t\t\t\tdisabled={soundNotificationsSaving}
\t\t\t\t\t\tonCheckedChange={(next) => {
\t\t\t\t\t\t\tvoid setSoundNotificationsEnabled(next);
\t\t\t\t\t\t}}
\t\t\t\t\t/>
\t\t\t\t</SettingsRow>
\t\t\t\t{soundNotificationsSaveError ? (
\t\t\t\t\t<p role="alert" className="px-3 text-caption leading-4 text-error">
\t\t\t\t\t\t{t("settings.soundNotifications.saveFailed")}
\t\t\t\t\t</p>
\t\t\t\t) : null}
\t\t\t</SettingsSection>

\t\t\t{/* Advanced */}
\t\t\t<SettingsSection title={t("settings.advanced")} grouped>
\t\t\t\t{import.meta.env.VITE_AO_CLOUD_BETA === "true" ? (
\t\t\t\t\t<>
\t\t\t\t\t\t<SettingsRow label={t("settings.cloudBeta")}>
\t\t\t\t\t\t\t<Switch
\t\t\t\t\t\t\t\taria-label={t("settings.cloudBeta")}
\t\t\t\t\t\t\t\tchecked={cloudBetaEnabled}
\t\t\t\t\t\t\t\tdisabled={cloudBetaSaving}
\t\t\t\t\t\t\t\tonCheckedChange={(next) => {
\t\t\t\t\t\t\t\t\tvoid setCloudBetaEnabled(next);
\t\t\t\t\t\t\t\t}}
\t\t\t\t\t\t\t/>
\t\t\t\t\t\t</SettingsRow>
\t\t\t\t\t\t{cloudBetaSaveError ? (
\t\t\t\t\t\t\t<p role="alert" className="px-3 text-caption leading-4 text-error">
\t\t\t\t\t\t\t\t{t("settings.cloudBetaSaveFailed")}
\t\t\t\t\t\t\t</p>
\t\t\t\t\t\t) : null}
\t\t\t\t\t\t{cloudBetaEnabled ? <CloudAccountSettingsRow /> : null}
\t\t\t\t\t</>
\t\t\t\t) : null}
\t\t\t\t<SettingsRow label={t("settings.developerMode")}>
\t\t\t\t\t<Switch
\t\t\t\t\t\taria-label={t("settings.developerMode")}
\t\t\t\t\t\tchecked={developerMode}
\t\t\t\t\t\tonCheckedChange={setDeveloperMode}
\t\t\t\t\t/>
\t\t\t\t</SettingsRow>
\t\t\t</SettingsSection>
\t\t</>
\t);
}
