import type { AoBridge } from "../preload";

declare global {
	interface Window {
		ao?: AoBridge;
	}

	interface ImportMetaEnv {
		readonly VITE_AO_POSTHOG_KEY?: string;
		readonly VITE_AO_POSTHOG_HOST?: string;
		readonly VITE_AO_CLOUD_BETA?: string;
		readonly VITE_AO_CLOUD_API_BASE_URL?: string;
	}
}

export {};
