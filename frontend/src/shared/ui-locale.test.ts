import { describe, expect, it } from "vitest";
import {
	APP_LOCALES,
	DEFAULT_LOCALE,
	DEFAULT_UI_SETTINGS,
	coerceLocale,
	coerceUiSettings,
} from "./ui-locale";

describe("shared UI locale schema", () => {
	it("accepts only supported locale identifiers", () => {
		expect(APP_LOCALES).toEqual(["en", "zh-CN", "ja", "ko", "es", "fr", "de", "pt-BR"]);
		expect(coerceLocale("en")).toBe("en");
		expect(coerceLocale("zh-CN")).toBe("zh-CN");
		expect(coerceLocale("ja")).toBe("ja");
		expect(coerceLocale("ko")).toBe("ko");
		expect(coerceLocale("es")).toBe("es");
		expect(coerceLocale("fr")).toBe("fr");
		expect(coerceLocale("de")).toBe("de");
		expect(coerceLocale("pt-BR")).toBe("pt-BR");
		expect(coerceLocale("zh")).toBe(DEFAULT_LOCALE);
		expect(coerceLocale("pt")).toBe(DEFAULT_LOCALE);
		expect(coerceLocale({ locale: "zh-CN" })).toBe(DEFAULT_LOCALE);
	});

	it("normalizes persisted settings through the shared locale validator", () => {
		expect(coerceUiSettings({ locale: "zh-CN" })).toEqual({ locale: "zh-CN", soundNotificationsEnabled: true });
		expect(coerceUiSettings({ locale: "ja" })).toEqual({ locale: "ja", soundNotificationsEnabled: true });
		expect(coerceUiSettings({ locale: "pt-BR" })).toEqual({ locale: "pt-BR", soundNotificationsEnabled: true });
		expect(coerceUiSettings({ locale: "pt" })).toEqual(DEFAULT_UI_SETTINGS);
		expect(coerceUiSettings(null)).toEqual(DEFAULT_UI_SETTINGS);
	});

	it("defaults soundNotificationsEnabled to true and accepts a persisted boolean", () => {
		expect(DEFAULT_UI_SETTINGS).toEqual({ locale: "en", soundNotificationsEnabled: true });
		expect(coerceUiSettings({ locale: "en", soundNotificationsEnabled: false })).toEqual({
			locale: "en",
			soundNotificationsEnabled: false,
		});
		expect(coerceUiSettings({ locale: "en", soundNotificationsEnabled: true })).toEqual({
			locale: "en",
			soundNotificationsEnabled: true,
		});
	});

	it("coerces a non-boolean or missing soundNotificationsEnabled to the default (true)", () => {
		expect(coerceUiSettings({ locale: "en" })).toEqual({ locale: "en", soundNotificationsEnabled: true });
		expect(coerceUiSettings({ locale: "en", soundNotificationsEnabled: "false" })).toEqual({
			locale: "en",
			soundNotificationsEnabled: true,
		});
		expect(coerceUiSettings({ locale: "en", soundNotificationsEnabled: null })).toEqual({
			locale: "en",
			soundNotificationsEnabled: true,
		});
	});
});
