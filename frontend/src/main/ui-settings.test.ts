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
		await writeUiSettings(dir, { locale: "zh-CN", cloudEnabled: true });
		expect(await readUiSettings(dir)).toEqual({ locale: "zh-CN", cloudEnabled: true });
		await writeUiSettings(dir, { locale: "en", cloudEnabled: false });
		expect(await readUiSettings(dir)).toEqual({ locale: "en", cloudEnabled: false });
	});

	it("merges partial updates without losing another preference", async () => {
		await writeUiSettings(dir, { locale: "fr", cloudEnabled: false });
		expect(await updateUiSettings(dir, { cloudEnabled: true })).toEqual({ locale: "fr", cloudEnabled: true });
		expect(await updateUiSettings(dir, { locale: "ja" })).toEqual({ locale: "ja", cloudEnabled: true });
	});

	it("falls back to defaults on garbage", async () => {
		await writeFile(path.join(dir, UI_SETTINGS_FILE_NAME), "{not json", "utf8");
		expect(await readUiSettings(dir)).toEqual(DEFAULT_UI_SETTINGS);
	});

	it("coerces unknown locale to en and accepts supported locales", () => {
		expect(coerceUiSettings({ locale: "xx" })).toEqual({ locale: "en", cloudEnabled: false });
		expect(coerceUiSettings({ locale: "zh" })).toEqual({ locale: "en", cloudEnabled: false });
		expect(coerceUiSettings({})).toEqual({ locale: "en", cloudEnabled: false });
		expect(coerceUiSettings(null)).toEqual({ locale: "en", cloudEnabled: false });
		expect(coerceUiSettings({ locale: "zh-CN", cloudEnabled: true })).toEqual({ locale: "zh-CN", cloudEnabled: true });
		expect(coerceUiSettings({ locale: "fr" })).toEqual({ locale: "fr", cloudEnabled: false });
		expect(coerceUiSettings({ locale: "pt-BR" })).toEqual({ locale: "pt-BR", cloudEnabled: false });
	});

	it("atomic write leaves no temp file behind", async () => {
		await writeUiSettings(dir, { locale: "zh-CN", cloudEnabled: false });
		const entries = await readdir(dir);
		expect(entries).toEqual([UI_SETTINGS_FILE_NAME]);
	});
});
