import { create } from "zustand";
import { aoBridge } from "../lib/bridge";
import type { CloudAvailability } from "../../shared/cloud-account";

const UNAVAILABLE: CloudAvailability = { available: false, enabled: false };

type CloudSettingsState = {
	/**
	 * Authoritative gate, owned by Electron main. The renderer never derives it
	 * from a build flag of its own, so a toggle change takes effect everywhere
	 * (sidebar, project creation, transport routing) from one read.
	 */
	availability: CloudAvailability;
	loaded: boolean;
	saving: boolean;
	saveError: boolean;
	load: () => Promise<void>;
	setEnabled: (enabled: boolean) => Promise<void>;
};

let pendingLoad: Promise<void> | undefined;

export const useCloudSettingsStore = create<CloudSettingsState>((set, get) => ({
	availability: UNAVAILABLE,
	loaded: false,
	saving: false,
	saveError: false,
	load: async () => {
		if (get().loaded) return;
		if (pendingLoad) return pendingLoad;
		pendingLoad = (async () => {
			let availability = UNAVAILABLE;
			try {
				availability = await aoBridge.cloud.getAvailability();
			} catch {
				// No bridge, no control plane, or main refused: cloud stays invisible.
			}
			set({ availability, loaded: true });
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
			await aoBridge.uiSettings.set({ cloudEnabled: enabled });
			// Re-read rather than assume: main refuses to enable a build that has no
			// control-plane URL or Google client configured.
			const availability = await aoBridge.cloud.getAvailability();
			set({ availability, loaded: true, saving: false });
		} catch {
			set({ saving: false, saveError: true });
		}
	},
}));
