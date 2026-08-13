import en from "./en.json";
import type { AppLocale } from "./locales";

/** English is the source-of-truth catalog; keys are typed from it. */
export const enMessages = en;

export type MessageKey = keyof typeof enMessages;

type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralMessageKey = MessageKey extends infer Key extends string
	? Key extends `${infer Base}_${PluralCategory}`
		? Base
		: never
	: never;

export type MessageCatalog = Record<MessageKey, string>;
type RuntimeCatalog = Readonly<Record<string, string>>;

const catalogLoaders: Record<Exclude<AppLocale, "en">, () => Promise<RuntimeCatalog>> = {
	"zh-CN": () => import("./zh-CN.json").then((module) => module.default),
	ja: () => import("./ja.json").then((module) => module.default),
	ko: () => import("./ko.json").then((module) => module.default),
	es: () => import("./es.json").then((module) => module.default),
	fr: () => import("./fr.json").then((module) => module.default),
	de: () => import("./de.json").then((module) => module.default),
	"pt-BR": () => import("./pt-BR.json").then((module) => module.default),
};

const pendingCatalogs = new Map<AppLocale, Promise<RuntimeCatalog>>();

/** Load the selected locale on demand instead of including every catalog in the renderer entry chunk. */
export function loadCatalog(locale: AppLocale): Promise<RuntimeCatalog> {
	if (locale === "en") return Promise.resolve(enMessages);
	const pending = pendingCatalogs.get(locale);
	if (pending) return pending;
	const loading = catalogLoaders[locale]().catch((error: unknown) => {
		pendingCatalogs.delete(locale);
		throw error;
	});
	pendingCatalogs.set(locale, loading);
	return loading;
}
