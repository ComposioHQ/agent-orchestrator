import { createInstance, type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import { APP_LOCALES, DEFAULT_LOCALE, type AppLocale } from "./locales";
import { enMessages, loadCatalog } from "./messages";

export type TranslationCatalogs = Partial<Record<AppLocale, Readonly<Record<string, string>>>>;

export const appCatalogs: TranslationCatalogs = {
	en: enMessages,
};

/** Create an isolated, synchronously initialized instance for app startup and unit tests. */
export function createAppI18n(locale: AppLocale = DEFAULT_LOCALE, catalogs: TranslationCatalogs = appCatalogs): i18n {
	return initializeI18n(createInstance(), locale, catalogs);
}

function initializeI18n(instance: i18n, locale: AppLocale, catalogs: TranslationCatalogs): i18n {
	const resources = Object.fromEntries(
		APP_LOCALES.map((lng) => [lng, { translation: catalogs[lng] ?? {} }]),
	);
	void instance.init({
		lng: locale,
		fallbackLng: DEFAULT_LOCALE,
		supportedLngs: [...APP_LOCALES],
		load: "currentOnly",
		resources,
		defaultNS: "translation",
		keySeparator: false,
		nsSeparator: false,
		returnNull: false,
		initAsync: false,
		interpolation: { escapeValue: false },
	});
	return instance;
}

export const appI18n = initializeI18n(createInstance().use(initReactI18next), DEFAULT_LOCALE, appCatalogs);

/** Ensure the requested catalog is present before switching the renderer language. */
export async function setAppLocale(locale: AppLocale): Promise<void> {
	const catalog = await loadCatalog(locale);
	appI18n.addResourceBundle(locale, "translation", catalog, true, true);
	await appI18n.changeLanguage(locale);
}
