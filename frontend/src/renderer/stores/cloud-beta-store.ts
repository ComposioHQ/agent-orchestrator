import { create } from "zustand";
import { aoBridge } from "../lib/bridge";

type CloudBetaState = {
	enabled: boolean;
	loaded: boolean;
	saving: boolean;
	saveError: boolean;
	load: () => Promise<void>;
	setEnabled: (enabled: boolean) => Promise<void>;
};

let settingRevision = 0;
let pendingLoad: Promise<void> | undefined;

export const useCloudBetaStore = create<CloudBetaState>((set, get) => ({
	enabled: false,
	loaded: false,
	saving: false,
	saveError: false,
	load: async () => {
		if (get().loaded) return;
		if (pendingLoad) return pendingLoad;
		const revisionAtStart = settingRevision;
		pendingLoad = (async () => {
			let enabled = false;
			try {
				const settings = await aoBridge.uiSettings.get();
				enabled = settings.cloudBetaEnabled;
			} catch {
				// An unavailable setting must leave unreleased Cloud surfaces hidden.
			}
			if (revisionAtStart === settingRevision) set({ enabled, loaded: true });
		})();
		try {
			await pendingLoad;
		} finally {
			pendingLoad = undefined;
		}
	},
	setEnabled: async (enabled) => {
		const revision = ++settingRevision;
		set({ saving: true, saveError: false });
		try {
			await aoBridge.uiSettings.set({ cloudBetaEnabled: enabled });
			if (revision === settingRevision) set({ enabled, loaded: true, saving: false });
		} catch {
			if (revision === settingRevision) set({ saving: false, saveError: true });
		}
	},
}));
