import de from "../renderer/i18n/de.json";
import en from "../renderer/i18n/en.json";
import es from "../renderer/i18n/es.json";
import fr from "../renderer/i18n/fr.json";
import ja from "../renderer/i18n/ja.json";
import ko from "../renderer/i18n/ko.json";
import ptBR from "../renderer/i18n/pt-BR.json";
import zhCN from "../renderer/i18n/zh-CN.json";
import type { AppLocale } from "../shared/ui-locale";

export type TrayMessageKey = keyof typeof en;
type TrayCatalog = Readonly<Record<string, string>>;

const catalogs: Record<AppLocale, TrayCatalog> = {
	en,
	"zh-CN": zhCN,
	ja,
	ko,
	es,
	fr,
	de,
	"pt-BR": ptBR,
};

export function trayCatalogFor(locale: AppLocale): TrayCatalog {
	return catalogs[locale] ?? catalogs.en;
}
