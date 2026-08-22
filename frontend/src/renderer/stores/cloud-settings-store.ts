import { create } from "zustand";
import { aoBridge } from "../lib/bridge";

type CloudSettingsState = {
	enabled: boolean;
	loaded: boolean;
	saving: boolean;
	saveError: boolean;
	load: () => Promise<void>;
	setEnabled: (enabled: boolean) => Promise<void>;
};

let pendingLoad: Promise<void> | undefined;

export const useCloudSettingsStore = create<CloudSettingsState>((set, get) => ({
	enabled: false,
	loaded: false,
	saving: false,
	saveError: false,
	load: async () => {
		if (get().loaded) return;
		if (pendingLoad) return pendingLoad;
		pendingLoad = (async () => {
			try {
				const settings = await aoBridge.uiSettings.get();
				set({ enabled: settings.cloudEnabled, loaded: true });
			} catch {
				set({ enabled: false, loaded: true });
			}
		})();
		try {
			await pendingLoad;
		} finally {
			pendingLoad = undefined;
		}
	},
	setEnabled: async (enabled) => {
		set({ saving: true, saveError: false });
		try {
			const settings = await aoBridge.uiSettings.set({ cloudEnabled: enabled });
			set({ enabled: settings.cloudEnabled, loaded: true, saving: false });
		} catch {
			set({ saving: false, saveError: true });
		}
	},
}));
