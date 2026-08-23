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
		expect(coerceUiSettings({ locale: "zh-CN" })).toEqual({
			locale: "zh-CN",
			cloudEnabled: false,
			soundNotificationsEnabled: true,
		});
		expect(coerceUiSettings({ locale: "ja" }).locale).toBe("ja");
		expect(coerceUiSettings({ locale: "pt-BR" }).locale).toBe("pt-BR");
		expect(coerceUiSettings({ locale: "pt" })).toEqual(DEFAULT_UI_SETTINGS);
		expect(coerceUiSettings(null)).toEqual(DEFAULT_UI_SETTINGS);
	});

	it("keeps the cloud early-access opt-in strictly boolean", () => {
		expect(coerceUiSettings({ locale: "en", cloudEnabled: true }).cloudEnabled).toBe(true);
		expect(coerceUiSettings({ locale: "en", cloudEnabled: "true" }).cloudEnabled).toBe(false);
		expect(coerceUiSettings({ locale: "en" }).cloudEnabled).toBe(false);
	});

	it("defaults soundNotificationsEnabled to true and accepts a persisted boolean", () => {
		expect(DEFAULT_UI_SETTINGS.soundNotificationsEnabled).toBe(true);
		expect(coerceUiSettings({ locale: "en", soundNotificationsEnabled: false }).soundNotificationsEnabled).toBe(false);
		expect(coerceUiSettings({ locale: "en", soundNotificationsEnabled: true }).soundNotificationsEnabled).toBe(true);
	});

	it("coerces a non-boolean or missing soundNotificationsEnabled to the default (true)", () => {
		expect(coerceUiSettings({ locale: "en" }).soundNotificationsEnabled).toBe(true);
		expect(coerceUiSettings({ locale: "en", soundNotificationsEnabled: "false" }).soundNotificationsEnabled).toBe(true);
		expect(coerceUiSettings({ locale: "en", soundNotificationsEnabled: null }).soundNotificationsEnabled).toBe(true);
	});
});
