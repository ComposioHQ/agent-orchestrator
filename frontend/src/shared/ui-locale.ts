/** UI locales supported across the Electron main, preload, and renderer boundaries. */
export const APP_LOCALES = ["en", "zh-CN", "ja", "ko", "es", "fr", "de", "pt-BR"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

export interface UiSettings {
	locale: AppLocale;
	/** Whether attention-worthy notifications (needs input, ready to merge) also play a sound. */
	soundNotificationsEnabled: boolean;
}

export const DEFAULT_UI_SETTINGS: UiSettings = { locale: DEFAULT_LOCALE, soundNotificationsEnabled: true };

/** Normalize an unknown value to a supported UI locale. */
export function coerceLocale(raw: unknown): AppLocale {
	if (typeof raw === "string" && (APP_LOCALES as readonly string[]).includes(raw)) {
		return raw as AppLocale;
	}
	return DEFAULT_LOCALE;
}

/** Normalize unknown persisted or IPC data to the supported UI-settings schema. */
export function coerceUiSettings(raw: unknown): UiSettings {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_UI_SETTINGS };
	const record = raw as Record<string, unknown>;
	const soundNotificationsEnabled =
		typeof record.soundNotificationsEnabled === "boolean"
			? record.soundNotificationsEnabled
			: DEFAULT_UI_SETTINGS.soundNotificationsEnabled;
	return { locale: coerceLocale(record.locale), soundNotificationsEnabled };
}
