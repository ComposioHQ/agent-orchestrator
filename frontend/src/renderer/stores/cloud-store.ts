import { create } from "zustand";
import { aoBridge } from "../lib/bridge";
import type { CloudAccount, CloudAvailability } from "../../shared/cloud-account";

const UNAVAILABLE: CloudAvailability = { available: false, enabled: false, apiBaseUrl: "" };

type CloudState = {
	/**
	 * Authoritative gate, owned by Electron main. The renderer never derives it
	 * from a build flag of its own, so a toggle change takes effect everywhere
	 * (sidebar, project creation, transport routing) from one read.
	 */
	availability: CloudAvailability;
	/** Token-free account view; null while signed out or while cloud is off. */
	account: CloudAccount | null;
	loaded: boolean;
	accountLoaded: boolean;
	saving: boolean;
	saveError: boolean;
	load: () => Promise<void>;
	setEnabled: (enabled: boolean) => Promise<void>;
	setAccount: (account: CloudAccount | null) => void;
	signIn: () => Promise<void>;
	signOut: () => Promise<void>;
};

let pendingLoad: Promise<void> | undefined;

async function readAvailability(): Promise<CloudAvailability> {
	try {
		return await aoBridge.cloud.getAvailability();
	} catch {
		// No bridge, no control plane, or main refused: cloud stays invisible.
		return UNAVAILABLE;
	}
}

export const useCloudStore = create<CloudState>((set, get) => ({
	availability: UNAVAILABLE,
	account: null,
	loaded: false,
	accountLoaded: false,
	saving: false,
	saveError: false,
	load: async () => {
		if (get().loaded) return;
		if (pendingLoad) return pendingLoad;
		pendingLoad = (async () => {
			const availability = await readAvailability();
			if (!availability.enabled) {
				set({ availability, account: null, loaded: true, accountLoaded: true });
				return;
			}
			const account = await aoBridge.cloud.getSession().catch(() => null);
			set({ availability, account, loaded: true, accountLoaded: true });
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
			const account = availability.enabled ? await aoBridge.cloud.getSession().catch(() => null) : null;
			set({ availability, account, loaded: true, accountLoaded: true, saving: false });
		} catch {
			set({ saving: false, saveError: true });
		}
	},
	setAccount: (account) => set({ account, accountLoaded: true }),
	signIn: async () => {
		const account = await aoBridge.cloud.signIn();
		if (account) set({ account, accountLoaded: true });
	},
	signOut: async () => {
		await aoBridge.cloud.signOut();
		set({ account: null, accountLoaded: true });
	},
}));

/**
 * Synchronous read for non-React callers — the workspace query needs to know
 * whether to fan out to the control plane, and for which organizations, without
 * threading cloud state through every query option.
 */
export function cloudTransportSnapshot(): {
	enabled: boolean;
	apiBaseUrl: string;
	organizations: CloudAccount["organizations"];
} {
	const { availability, account } = useCloudStore.getState();
	return {
		enabled: availability.enabled && account !== null,
		apiBaseUrl: availability.apiBaseUrl,
		organizations: account?.organizations ?? [],
	};
}
