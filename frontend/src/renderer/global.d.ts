import type { AoBridge } from "../preload";
import type { RenderProfileBridge } from "./lib/render-profiler";

declare global {
	interface Window {
		ao?: AoBridge;
		__aoRenderProfile?: RenderProfileBridge;
	}

	interface ImportMetaEnv {
		readonly VITE_AO_POSTHOG_KEY?: string;
		readonly VITE_AO_POSTHOG_HOST?: string;
	}
}

export {};
