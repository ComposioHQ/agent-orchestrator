// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	coerceUiSettings,
	readUiSettings,
	updateUiSettings,
	writeUiSettings,
	UI_SETTINGS_FILE_NAME,
	DEFAULT_UI_SETTINGS,
} from "./ui-settings";

describe("ui-settings", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-ui-settings-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns safe defaults when no file exists", async () => {
		expect(await readUiSettings(dir)).toEqual(DEFAULT_UI_SETTINGS);
	});

	it("round-trips written locale", async () => {
		await writeUiSettings(dir, { locale: "zh-CN", cloudEnabled: false });
		expect(await readUiSettings(dir)).toEqual({ locale: "zh-CN", cloudEnabled: false, soundNotificationsEnabled: true });
		await writeUiSettings(dir, { locale: "en", cloudEnabled: false });
		expect(await readUiSettings(dir)).toEqual({ locale: "en", cloudEnabled: false, soundNotificationsEnabled: true });
	});

	it("merges a partial update without clobbering the other store's field", async () => {
		await updateUiSettings(dir, { locale: "fr" });
		await updateUiSettings(dir, { cloudEnabled: true });
		expect(await readUiSettings(dir)).toEqual({ locale: "fr", cloudEnabled: true, soundNotificationsEnabled: true });

		await updateUiSettings(dir, { locale: "ja" });
		expect(await readUiSettings(dir)).toEqual({ locale: "ja", cloudEnabled: true, soundNotificationsEnabled: true });
	});

	it("serializes concurrent partial updates from independent stores", async () => {
		await Promise.all([updateUiSettings(dir, { locale: "de" }), updateUiSettings(dir, { cloudEnabled: true })]);
		expect(await readUiSettings(dir)).toEqual({ locale: "de", cloudEnabled: true, soundNotificationsEnabled: true });
	});

	it("falls back to defaults on garbage", async () => {
		await writeFile(path.join(dir, UI_SETTINGS_FILE_NAME), "{not json", "utf8");
		expect(await readUiSettings(dir)).toEqual(DEFAULT_UI_SETTINGS);
	});

	it("coerces unknown locale to en and accepts supported locales", () => {
		expect(coerceUiSettings({ locale: "xx" })).toEqual(DEFAULT_UI_SETTINGS);
		expect(coerceUiSettings({ locale: "zh" })).toEqual(DEFAULT_UI_SETTINGS);
		expect(coerceUiSettings({})).toEqual(DEFAULT_UI_SETTINGS);
		expect(coerceUiSettings(null)).toEqual(DEFAULT_UI_SETTINGS);
		expect(coerceUiSettings({ locale: "zh-CN" })).toEqual({ locale: "zh-CN", cloudEnabled: false, soundNotificationsEnabled: true });
		expect(coerceUiSettings({ locale: "fr" })).toEqual({ locale: "fr", cloudEnabled: false, soundNotificationsEnabled: true });
		expect(coerceUiSettings({ locale: "pt-BR" })).toEqual({ locale: "pt-BR", cloudEnabled: false, soundNotificationsEnabled: true });
	});

	it("atomic write leaves no temp file behind", async () => {
		await writeUiSettings(dir, { locale: "zh-CN", cloudEnabled: false });
		const entries = await readdir(dir);
		expect(entries).toEqual([UI_SETTINGS_FILE_NAME]);
	});
});
