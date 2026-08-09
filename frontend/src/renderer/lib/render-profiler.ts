import type { ProfilerOnRenderCallback } from "react";

export type RenderProfileEntry = Readonly<{
	id: string;
	phase: Parameters<ProfilerOnRenderCallback>[1];
	actualDuration: number;
	baseDuration: number;
	startTime: number;
	commitTime: number;
}>;

export type RenderProfileBridge = Readonly<{
	clear: () => void;
	entries: () => RenderProfileEntry[];
}>;

export const RENDER_PROFILE_LIMIT = 250;

const entries: RenderProfileEntry[] = [];

export const recordRenderProfile: ProfilerOnRenderCallback = (
	id,
	phase,
	actualDuration,
	baseDuration,
	startTime,
	commitTime,
) => {
	entries.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
	if (entries.length > RENDER_PROFILE_LIMIT) entries.splice(0, entries.length - RENDER_PROFILE_LIMIT);
};

export function clearRenderProfile(): void {
	entries.length = 0;
}

export function getRenderProfile(): RenderProfileEntry[] {
	return [...entries];
}

export function installRenderProfileBridge(target: Window): void {
	target.__aoRenderProfile = {
		clear: clearRenderProfile,
		entries: getRenderProfile,
	};
}
