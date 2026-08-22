import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCloudSettingsStore } from "./cloud-settings-store";

const getUiSettings = vi.fn();
const setUiSettings = vi.fn();

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		uiSettings: {
			get: (...args: unknown[]) => getUiSettings(...args),
			set: (...args: unknown[]) => setUiSettings(...args),
		},
	},
}));

describe("cloud-settings-store", () => {
	beforeEach(() => {
		getUiSettings.mockReset();
		setUiSettings.mockReset();
		useCloudSettingsStore.setState({ enabled: false, loaded: false, saving: false, saveError: false });
	});

	it("loads the persisted Cloud preference", async () => {
		getUiSettings.mockResolvedValue({ locale: "en", cloudEnabled: true });

		await useCloudSettingsStore.getState().load();

		expect(useCloudSettingsStore.getState()).toMatchObject({ enabled: true, loaded: true, saveError: false });
	});

	it("persists only the Cloud preference", async () => {
		setUiSettings.mockResolvedValue({ locale: "fr", cloudEnabled: true });

		await useCloudSettingsStore.getState().setEnabled(true);

		expect(setUiSettings).toHaveBeenCalledWith({ cloudEnabled: true });
		expect(useCloudSettingsStore.getState()).toMatchObject({ enabled: true, loaded: true, saving: false });
	});

	it("keeps the previous value and reports a failed save", async () => {
		useCloudSettingsStore.setState({ enabled: true, loaded: true });
		setUiSettings.mockRejectedValue(new Error("disk full"));

		await useCloudSettingsStore.getState().setEnabled(false);

		expect(useCloudSettingsStore.getState()).toMatchObject({ enabled: true, saving: false, saveError: true });
	});
});
