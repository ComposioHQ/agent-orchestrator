import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUiSettings, setUiSettings } = vi.hoisted(() => ({
	getUiSettings: vi.fn(),
	setUiSettings: vi.fn(),
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: { uiSettings: { get: getUiSettings, set: setUiSettings } },
}));

import { useCloudBetaStore } from "./cloud-beta-store";

describe("cloud-beta-store", () => {
	beforeEach(() => {
		getUiSettings.mockReset();
		setUiSettings.mockReset();
		useCloudBetaStore.setState({ enabled: false, loaded: false, saving: false, saveError: false });
	});

	it("loads the persisted opt-in", async () => {
		getUiSettings.mockResolvedValue({ locale: "en", soundNotificationsEnabled: true, cloudBetaEnabled: true });
		await useCloudBetaStore.getState().load();
		expect(useCloudBetaStore.getState()).toMatchObject({ enabled: true, loaded: true });
	});

	it("persists an opt-in before exposing Cloud UI", async () => {
		setUiSettings.mockResolvedValue({ locale: "en", soundNotificationsEnabled: true, cloudBetaEnabled: true });
		await useCloudBetaStore.getState().setEnabled(true);
		expect(setUiSettings).toHaveBeenCalledWith({ cloudBetaEnabled: true });
		expect(useCloudBetaStore.getState()).toMatchObject({ enabled: true, loaded: true, saving: false });
	});
});
